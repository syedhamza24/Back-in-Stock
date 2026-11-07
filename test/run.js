'use strict';
// Integration test: fake stock API + fake Resend, real server process.
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = 4100, FAKE = 4101, SECRET = 'whsec_test';
const stock = { 'SKU-1': { sku: 'SKU-1', name: 'Trail Jacket', quantity: 0, in_stock: false }, 'SKU-2': { sku: 'SKU-2', name: 'Wool Beanie', quantity: 0, in_stock: false } };
const sent = [];
let failNextSend = 0;

const fake = http.createServer((req, res) => {
  const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/emails' && req.method === 'POST') {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      if (failNextSend > 0) { failNextSend--; return send(500, { error: 'boom' }); }
      sent.push({ ...JSON.parse(b), key: req.headers['idempotency-key'], auth: req.headers.authorization });
      send(200, { id: 'msg_' + sent.length });
    });
    return;
  }
  if (req.headers.authorization !== 'Bearer sk') return send(401, {});
  if (req.url === '/stock') return send(200, Object.values(stock));
  const m = /^\/stock\/(.+)$/.exec(req.url);
  if (m && stock[m[1]]) return send(200, stock[m[1]]);
  send(404, {});
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bis-'));
let child;
const startApp = () => new Promise((resolve) => {
  child = spawn('node', ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: { ...process.env, PORT: APP, DATA_DIR: dataDir, WEBHOOK_SECRET: SECRET, STOCK_API_URL: `http://localhost:${FAKE}/stock`, STOCK_API_KEY: 'sk', RESEND_API_KEY: 're_x', RESEND_BASE_URL: `http://localhost:${FAKE}` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
});
const stopApp = () => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); });

const call = (p, opts = {}) => fetch(`http://localhost:${APP}${p}`, opts).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const post = (p, body, headers = {}) => call(p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const hook = (event_id, sku, quantity) => post('/webhooks/stock', { event_id, sku, quantity }, { 'x-webhook-secret': SECRET });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fails++; };

(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  await startApp();

  // validation + dedupe
  ok('bad email -> 400', (await post('/api/requests', { email: 'nope', sku: 'SKU-1' })).s === 400);
  ok('unknown sku -> 404', (await post('/api/requests', { email: 'a@b.co', sku: 'NOPE' })).s === 404);
  ok('first request -> 201', (await post('/api/requests', { email: 'Ann@Example.com', sku: 'SKU-1' })).s === 201);
  const dup = await post('/api/requests', { email: 'ann@example.com ', sku: 'SKU-1' });
  ok('duplicate open request (case/space-insensitive) -> 200 already_requested', dup.s === 200 && dup.b.already_requested === true);
  const parallel = await Promise.all(Array.from({ length: 10 }, () => post('/api/requests', { email: 'bob@example.com', sku: 'SKU-1' })));
  ok('10 parallel identical requests -> exactly one 201', parallel.filter((r) => r.s === 201).length === 1);

  // webhook auth + validation
  ok('missing secret -> 401', (await post('/webhooks/stock', { event_id: 'e0', sku: 'SKU-1', quantity: 5 })).s === 401);
  ok('wrong secret -> 401', (await post('/webhooks/stock', { event_id: 'e0', sku: 'SKU-1', quantity: 5 }, { 'x-webhook-secret': 'x' })).s === 401);
  ok('malformed payload -> 400', (await post('/webhooks/stock', { sku: 'SKU-1' }, { 'x-webhook-secret': SECRET })).s === 400);

  // don't trust the webhook: it claims stock, the stock API says no
  await hook('e-lie', 'SKU-1', 50); await wait(500);
  ok('webhook claims restock but stock API says 0 -> no email', sent.length === 0);

  // real restock; 25 concurrent deliveries, mixed duplicate and distinct event ids
  stock['SKU-1'].quantity = 4; stock['SKU-1'].in_stock = true;
  await Promise.all([...Array.from({ length: 15 }, () => hook('e-real', 'SKU-1', 4)), ...Array.from({ length: 10 }, (_, i) => hook('e-real-' + i, 'SKU-1', 4))]);
  await wait(1500);
  ok('2 customers waiting, 25 concurrent webhooks -> exactly 2 emails', sent.length === 2);
  ok('emails go to the right people (lowercased)', sent.map((s) => s.to[0]).sort().join() === 'ann@example.com,bob@example.com');
  ok('email is HTML + text with idempotency key + auth', sent.every((s) => s.html.includes('Trail Jacket') && s.text && s.key && s.auth === 'Bearer re_x'));
  await hook('e-again', 'SKU-1', 4); await wait(500);
  ok('later webhook for same sku -> no repeat email', sent.length === 2);

  // transient send failure is retried with the same idempotency key
  // (retry backoff is 15s, so we only check the state here)
  failNextSend = 1;
  await post('/api/requests', { email: 'cy@example.com', sku: 'SKU-1' }); // in stock right now -> sent immediately (first attempt fails)
  await wait(800);
  const admin = await fetch(`http://localhost:${APP}/admin?status=pending`, { headers: { authorization: 'Basic ' + Buffer.from('x:' + SECRET).toString('base64') } });
  const pendingHtml = await admin.text();
  ok('failed send leaves request pending (not lost, not notified)', pendingHtml.includes('cy@example.com') && sent.length === 2);

  // survives restart: request taken while out of stock, restock happens while app is down
  await post('/api/requests', { email: 'dee@example.com', sku: 'SKU-2' });
  await stopApp();
  stock['SKU-2'].quantity = 9; stock['SKU-2'].in_stock = true; // webhook was never received
  await startApp();
  await wait(3500);
  ok('restart + missed webhook -> sweep still notifies dee exactly once', sent.filter((s) => s.to[0] === 'dee@example.com').length === 1);
  ok('data survived restart (no re-send to ann/bob)', sent.filter((s) => /ann|bob/.test(s.to[0])).length === 2);

  // admin
  ok('admin without password -> 401', (await fetch(`http://localhost:${APP}/admin`)).status === 401);
  const html = await (await fetch(`http://localhost:${APP}/admin`, { headers: { authorization: 'Basic ' + Buffer.from('any:' + SECRET).toString('base64') } })).text();
  ok('admin shows notified status + timestamps', html.includes('ann@example.com') && html.includes('notified') && /UTC/.test(html));
  const emb = await fetch(`http://localhost:${APP}/embed`);
  ok('/embed is framable (no X-Frame-Options, frame-ancestors *)', !emb.headers.get('x-frame-options') && emb.headers.get('content-security-policy') === 'frame-ancestors *');

  await stopApp(); fake.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
