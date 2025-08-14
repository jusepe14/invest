// api/server.js  — MODELO USD->EUR
// npm i express cors node-fetch dotenv
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- utils ----------
const isISIN = v => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(String(v || '').toUpperCase());
async function fetchText(url, { timeoutMs = 8000, headers = {} } = {}) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, signal: ctrl.signal });
        const text = await r.text();
        return { ok: r.ok, status: r.status, text };
    } finally { clearTimeout(id); }
}
async function fetchJson(url, opts) {
    const r = await fetchText(url, opts);
    let json = null; try { json = JSON.parse(r.text); } catch { }
    return { ...r, json };
}

// ---------- price providers ----------
async function yahooQuote(symbol) {
    const hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
    for (const h of hosts) {
        const r = await fetchJson(`${h}/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`);
        if (!r.ok) continue;
        const q = r.json?.quoteResponse?.result?.[0];
        if (!q) continue;
        const price = q.regularMarketPrice ?? null;
        if (price == null) continue;
        return {
            price: Number(price),
            currency: q.currency || null,
            name: q.shortName || q.longName || symbol,
            time: q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString() : null,
            provider: 'yahoo'
        };
    }
    throw new Error('yahoo fail');
}
function stooqCandidates(symbol) {
    const hasSuffix = /\.[a-z]{2,4}$/i.test(symbol);
    const s = hasSuffix ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
    const bases = ['https://stooq.com', 'http://stooq.com', 'https://stooq.pl', 'http://stooq.pl'];
    const paths = [`/q/l/?s=${encodeURIComponent(s)}&i=d`, `/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`];
    const out = []; for (const b of bases) for (const p of paths) out.push(b + p);
    return out;
}
function parseStooqCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error('stooq no data');
    const header = lines[0].toLowerCase();
    if (header.includes('close')) {
        const idx = header.split(',').findIndex(h => h.trim() === 'close');
        const cols = lines[1].split(',');
        const px = Number(cols[idx]); if (!Number.isFinite(px)) throw new Error('stooq close invalido');
        return px;
    }
    const cols = lines[1].split(',');
    const px = Number(cols[6]); if (!Number.isFinite(px)) throw new Error('stooq invalido');
    return px;
}
async function stooqQuote(symbol) {
    let last = 'stooq fail';
    for (const url of stooqCandidates(symbol)) {
        try {
            const r = await fetchText(url);
            if (!r.ok) { last = `HTTP ${r.status}`; continue; }
            const px = parseStooqCSV(r.text);
            return { price: Number(px), currency: 'USD', name: symbol, time: null, provider: 'stooq' };
        } catch (e) { last = e.message; }
    }
    throw new Error(last);
}
const demoState = new Map();
function demoQuote(symbol) {
    const base = demoState.get(symbol) ?? (100 + Math.random() * 50);
    const next = +(base * (1 + (Math.random() - 0.5) * 0.004)).toFixed(2);
    demoState.set(symbol, next);
    return { price: next, currency: 'USD', name: symbol + ' (demo)', time: new Date().toISOString(), provider: 'demo' };
}
async function quoteAny(symbol) { try { return await yahooQuote(symbol); } catch { } try { return await stooqQuote(symbol); } catch { } return demoQuote(symbol); }

// === Pega esto en server.js (sustituye tu fxRate actual y /api/fx) ===
// Requiere que ya tengas fetchJson/fetchText definidos arriba.

const fxCache = new Map(); // "FROM->TO" -> { rate, ts, provider }

// Yahoo spot: USDEUR=X
async function yahooFxSpot(from, to) {
    const pair = `${from}${to}=X`.toUpperCase();
    const hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
    for (const h of hosts) {
        const r = await fetchJson(`${h}/v7/finance/quote?symbols=${encodeURIComponent(pair)}`, { timeoutMs: 8000 });
        const q = r.json?.quoteResponse?.result?.[0];
        const px = q?.regularMarketPrice;
        if (r.ok && Number.isFinite(px)) return { rate: Number(px), provider: 'yahoo' };
    }
    throw new Error('yahoo fx fail');
}

// Stooq spot: par USD/EUR (CSV)
async function stooqFxSpot(from, to) {
    // stooq usa "usdeur" o "eurusd" según el par; para USD/EUR queremos usdeur
    const sym = `${from}${to}`.toLowerCase();         // ej. "usdeur"
    const url = `https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetchText(url, { timeoutMs: 8000 });
    if (!r.ok) throw new Error('stooq http ' + r.status);
    const lines = r.text.trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error('stooq no data');
    const header = lines[0].split(',').map(s => s.trim().toLowerCase());
    const row = lines[1].split(',');
    const idx = header.indexOf('close');
    if (idx === -1) throw new Error('stooq sin close');
    const px = Number(row[idx]);
    if (!Number.isFinite(px)) throw new Error('stooq px invalido');
    return { rate: px, provider: 'stooq' };
}

// ECB (exchangerate.host) diario
async function ecbFx(from, to) {
    const r = await fetchJson(`https://api.exchangerate.host/convert?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { timeoutMs: 8000 });
    const rate = r?.json?.result;
    if (r.ok && Number.isFinite(rate)) return { rate: Number(rate), provider: 'ecb' };
    throw new Error('ecb fx fail');
}

// Orquestador con TTL 30s, orden: Yahoo -> Stooq -> ECB
async function fxRate(from, to) {
    from = String(from || '').toUpperCase();
    to = String(to || '').toUpperCase();
    if (!from || !to) throw new Error('from/to requeridos');
    if (from === to) return { rate: 1, provider: 'id' };

    const key = `${from}->${to}`;
    const now = Date.now();
    const cached = fxCache.get(key);
    if (cached && (now - cached.ts) < 30_000) return cached;

    // 1) Yahoo spot
    try {
        const y = await yahooFxSpot(from, to);
        if (y.rate > 0.5 && y.rate < 2) {
            const out = { ...y, ts: now };
            fxCache.set(key, out);
            return out;
        }
    } catch { }

    // 2) Stooq spot
    try {
        const s = await stooqFxSpot(from, to);
        if (s.rate > 0.5 && s.rate < 2) {
            const out = { ...s, ts: now };
            fxCache.set(key, out);
            return out;
        }
    } catch { }

    // 3) ECB diario
    const e = await ecbFx(from, to);
    if (e.rate > 0.5 && e.rate < 2) {
        const out = { ...e, ts: now };
        fxCache.set(key, out);
        return out;
    }

    throw new Error('fx no disponible');
}

// Endpoint FX
app.get('/api/fx', async (req, res) => {
    try {
        const from = String(req.query.from || '').toUpperCase();
        const to = String(req.query.to || '').toUpperCase();
        if (!from || !to) return res.status(400).json({ error: 'from/to requeridos' });
        const out = await fxRate(from, to);
        res.set('Cache-Control', 'no-store');
        res.json({ rate: out.rate, provider: out.provider });
    } catch (e) {
        res.status(502).json({ error: 'fx error: ' + e.message });
    }
});


// ---------- OpenFIGI (ISIN→ticker) ----------
async function openfigiMap(isin) {
    const r = await fetch('https://api.openfigi.com/v3/mapping', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(process.env.OPENFIGI_KEY ? { 'X-OPENFIGI-APIKEY': process.env.OPENFIGI_KEY } : {})
        },
        body: JSON.stringify([{ idType: 'ID_ISIN', idValue: isin }])
    });
    if (!r.ok) throw new Error('openfigi error');
    const j = await r.json();
    return j?.[0]?.data || [];
}

// ---------- candidatos (preferimos mercado USA si es posible) ----------
function uniq(arr) { return Array.from(new Set(arr.filter(Boolean))); }
async function candidatesFromQuery(q) {
    q = String(q || '').trim();
    if (!q) return [];
    if (!isISIN(q)) {
        const base = q.toUpperCase();
        return uniq([base, base + '.US']); // ticker simple y .US
    }
    // es ISIN -> pide a FIGI
    try {
        const data = await openfigiMap(q.toUpperCase());
        const tickers = data.map(d => String(d.ticker || '').toUpperCase()).filter(Boolean);
        // prioriza candidatos tal cual y añade .US
        const out = [];
        for (const t of tickers) { out.push(t); if (!/\.[A-Z]{1,4}$/.test(t)) out.push(t + '.US'); }
        return uniq(out.length ? out : [q.toUpperCase()]);
    } catch {
        return [q.toUpperCase()];
    }
}

// ---------- NUEVO: precio en USD unificado ----------
// /api/quote_usd?q=<ticker o ISIN>
// Devuelve { symbol, name, price_usd, currency:'USD', provider, resolvedFrom }
app.get('/api/quote_usd', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q requerido (ticker o ISIN)' });

    try {
        const cands = await candidatesFromQuery(q);
        const tried = [];

        for (const cand of cands) {
            tried.push(`yahoo:${cand}`);
            try {
                const qy = await yahooQuote(cand);
                if (qy?.price != null) {
                    let px = qy.price;
                    const cur = (qy.currency || 'USD').toUpperCase();
                    if (cur !== 'USD') {
                        const fx = await fxRate(cur, 'USD');
                        px = +(Math.round(px * fx.rate * 100) / 100).toFixed(2);
                    }
                    return res.json({
                        symbol: cand, name: qy.name, price_usd: px, currency: 'USD',
                        provider: qy.provider + (cur === 'USD' ? '' : '+fx'), resolvedFrom: q, tried
                    });
                }
            } catch (e) { tried.push(`yahoo_err:${cand}:${e.message}`); }
        }

        // Stooq como siguiente opción (ya suele estar en USD)
        const fb = cands[0] || q;
        tried.push(`stooq:${fb}`);
        try {
            const qs = await stooqQuote(fb);
            let px = qs.price;
            const cur = (qs.currency || 'USD').toUpperCase();
            if (cur !== 'USD') {
                const fx = await fxRate(cur, 'USD');
                px = +(Math.round(px * fx.rate * 100) / 100).toFixed(2);
            }
            return res.json({
                symbol: fb, name: qs.name, price_usd: px, currency: 'USD',
                provider: qs.provider + (cur === 'USD' ? '' : '+fx'), resolvedFrom: q, tried
            });
        } catch (e) { tried.push(`stooq_err:${fb}:${e.message}`); }

        // último recurso: demo + fx (normalmente ya USD)
        const qa = await quoteAny(fb);
        let px = qa.price;
        const cur = (qa.currency || 'USD').toUpperCase();
        if (cur !== 'USD') {
            try { const fx = await fxRate(cur, 'USD'); px = +(Math.round(px * fx.rate * 100) / 100).toFixed(2); } catch { }
        }
        return res.json({
            symbol: fb, name: qa.name, price_usd: px, currency: 'USD',
            provider: qa.provider + (cur === 'USD' ? '' : '+fx'), resolvedFrom: q, tried
        });

    } catch (e) {
        return res.status(500).json({ error: 'quote_usd error: ' + e.message });
    }
});

// compat antiguo
app.get('/api/quote', async (req, res) => {
    const symbol = String(req.query.symbol || '').trim();
    if (!symbol) return res.status(400).json({ error: 'symbol requerido' });
    try { const qy = await yahooQuote(symbol); res.json({ price: qy.price, currency: qy.currency, name: qy.name, provider: qy.provider }); }
    catch (e) { try { const qz = await stooqQuote(symbol); res.json(qz); } catch { res.status(500).json({ error: 'no se pudo obtener el precio' }); } }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[ok] API en http://localhost:${PORT}`));


// === OPENFIGI helpers (añadir junto a openfigiMap existente) ===
// Nota: ya usas process.env.OPENFIGI_KEY

function pickBestFigiEntry(arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    // Scoring simple: prioriza common stock en USA y USD
    const score = (d) => {
        let s = 0;
        const sec = String(d.securityType || '').toLowerCase();
        const ctry = String(d.country || '').toUpperCase();
        const cur = String(d.currency || '').toUpperCase();
        const mic = String(d.micCode || d.exchCode || '').toUpperCase();

        if (sec.includes('common')) s += 4;
        if (ctry === 'US') s += 3;
        if (cur === 'USD') s += 2;
        if (mic === 'XNAS' || mic === 'XNYS' || mic === 'BATS' || mic === 'ARCX') s += 3;
        if (String(d.ticker || '').toUpperCase() === 'MSFT') s += 1; // ejemplo de sesgo por exact match (opcional)
        return s;
    };
    return arr.slice().sort((a, b) => score(b) - score(a))[0];
}

async function openfigiByTicker(ticker) {
    const r = await fetch('https://api.openfigi.com/v3/mapping', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(process.env.OPENFIGI_KEY ? { 'X-OPENFIGI-APIKEY': process.env.OPENFIGI_KEY } : {})
        },
        body: JSON.stringify([{ idType: 'TICKER', idValue: String(ticker || '').toUpperCase() }])
    });
    if (!r.ok) throw new Error('openfigi ticker error');
    const j = await r.json();
    return j?.[0]?.data || [];
}

// === NUEVO endpoint: /api/resolve?q=<ticker o ISIN> ===
// Devuelve { name, isin, ticker }
app.get('/api/resolve', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q requerido (ticker o ISIN)' });

    try {
        if (isISIN(q)) {
            // ISIN -> nombre y posiblemente ticker
            const data = await openfigiMap(q.toUpperCase());
            if (!data.length) return res.status(404).json({ error: 'ISIN no encontrado' });
            const best = pickBestFigiEntry(data) || data[0];
            return res.json({
                name: best.name || best.securityName || q.toUpperCase(),
                isin: q.toUpperCase(),
                ticker: (best.ticker || '').toUpperCase() || null
            });
        } else {
            // Ticker -> nombre e ISIN
            const data = await openfigiByTicker(q.toUpperCase());
            if (!data.length) return res.status(404).json({ error: 'Ticker no encontrado' });
            const best = pickBestFigiEntry(data) || data[0];
            if (!best.isin) {
                // fallback: intenta resolución por ID_COMPOSITE (raro), o devuelve sin ISIN
                return res.json({
                    name: best.name || best.securityName || q.toUpperCase(),
                    isin: null,
                    ticker: (best.ticker || '').toUpperCase()
                });
            }
            return res.json({
                name: best.name || best.securityName || q.toUpperCase(),
                isin: String(best.isin).toUpperCase(),
                ticker: (best.ticker || '').toUpperCase()
            });
        }
    } catch (e) {
        return res.status(502).json({ error: 'resolve error: ' + e.message });
    }
});
