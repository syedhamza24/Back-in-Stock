'use strict';
const crypto = require('crypto');
const express = require('express');
const { db } = require('./db');
const { getStock, getCatalogue } = require('./stock');
const worker = require('./worker');
const { embedPage, adminPage, FILTERS } = require('./pages');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// --- tiny per-IP rate limiter (public form endpoint) ---
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
const limit = (max) => (req, res, next) => {
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  if (n > max) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
  next();
};

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.redirect('/embed'));

// ---------- embeddable form: must be framable from any store ----------
app.get('/embed', (req, res) => {
  res.set({ 'Content-Security-Policy': 'frame-ancestors *', 'Cache-Control': 'no-store' });
  res.type('html').send(embedPage());
});

// ---------- public API ----------
const cors = (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};

let catCache = { at: 0, data: [] };
app.get('/api/catalogue', cors, limit(120), async (req, res) => {
  try {
    if (Date.now() - catCache.at > 10_000) catCache = { at: Date.now(), data: await getCatalogue() };
    res.json(catCache.data.map(({ sku, name, inStock }) => ({ sku, name, inStock })));
  } catch {
    res.json([]); // the form works without suggestions
  }
});

app.post('/api/requests', cors, limit(30), express.json({ limit: '10kb' }), async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const sku = typeof body.sku === 'string' ? body.sku.trim() : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address, like you@example.com.' });
  if (!SKU_RE.test(sku)) return res.status(400).json({ error: 'Enter a valid item code.' });

  let stock;
  try {
    stock = await getStock(sku);
  } catch {
    return res.status(503).json({ error: "We couldn't check that item right now. Try again in a moment." });
  }
  if (!stock) return res.status(404).json({ error: `We couldn't find an item with code "${sku}". Check the code and try again.` });

  try {
    const r = db.prepare(`INSERT INTO requests (email, sku, product_name, created_at) VALUES (?,?,?,?)`).run(email, stock.sku, stock.name, Date.now());
    res.status(201).json({ id: Number(r.lastInsertRowid), status: 'pending', already_requested: false });
    if (stock.inStock) worker.processSku(stock.sku); // already back: don't make them wait for the sweep
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      const existing = db.prepare(`SELECT id,status FROM requests WHERE email=? AND sku=? AND status IN ('pending','sending')`).get(email, stock.sku);
      return res.status(200).json({ id: existing ? existing.id : null, status: existing ? existing.status : 'pending', already_requested: true });
    }
    console.error('[api] insert failed:', e.message);
    res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
  }
});

// ---------- stock webhook ----------
app.post('/webhooks/stock', express.json({ limit: '50kb' }), (req, res) => {
  const secret = process.env.WEBHOOK_SECRET || '';
  const given = req.get('X-Webhook-Secret') || '';
  if (!secret || !safeEqual(given, secret)) return res.status(401).json({ error: 'invalid secret' });

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const qty = Number(b.quantity);
  if (typeof b.event_id !== 'string' || !b.event_id || b.event_id.length > 200 ||
      typeof b.sku !== 'string' || !SKU_RE.test(b.sku) ||
      !Number.isFinite(qty) || qty < 0) {
    return res.status(400).json({ error: 'invalid payload' });
  }

  // Duplicate/concurrent deliveries: the PRIMARY KEY makes exactly one of them win.
  const ins = db.prepare(`INSERT OR IGNORE INTO events (event_id, sku, quantity, received_at) VALUES (?,?,?,?)`).run(b.event_id, b.sku, Math.floor(qty), Date.now());
  if (ins.changes === 0) return res.status(200).json({ ok: true, duplicate: true });

  res.status(200).json({ ok: true });
  // The payload is only a hint. processSku re-checks the stock API before anything is sent.
  if (qty > 0) worker.processSku(b.sku);
});

// ---------- admin ----------
const adminAuth = (req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
  const password = process.env.ADMIN_PASSWORD || process.env.WEBHOOK_SECRET || '';
  const m = /^Basic (.+)$/.exec(req.get('Authorization') || '');
  if (m && password) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const given = decoded.slice(decoded.indexOf(':') + 1); // username is ignored
    if (safeEqual(given, password)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Stock alerts admin", charset="UTF-8"').status(401).send('Password required');
};

app.get('/admin', adminAuth, (req, res) => {
  const filter = FILTERS.includes(req.query.status) ? req.query.status : 'all';
  const rows = filter === 'all'
    ? db.prepare(`SELECT * FROM requests ORDER BY id DESC LIMIT 500`).all()
    : db.prepare(`SELECT * FROM requests WHERE status=? ORDER BY id DESC LIMIT 500`).all(filter);
  const counts = {};
  let total = 0;
  for (const r of db.prepare(`SELECT status, COUNT(*) c FROM requests GROUP BY status`).all()) { counts[r.status] = r.c; total += r.c; }
  res.type('html').send(adminPage({ rows, counts, filter, total }));
});

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(err.status || 400).json({ error: 'invalid JSON body' });
  console.error('[server]', err);
  res.status(500).json({ error: 'internal error' });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  if (!process.env.ADMIN_PASSWORD) console.warn('[admin] ADMIN_PASSWORD not set: /admin password falls back to WEBHOOK_SECRET');
  const server = app.listen(port, '0.0.0.0', () => console.log(`listening on :${port}`));
  worker.start();
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
module.exports = app;
