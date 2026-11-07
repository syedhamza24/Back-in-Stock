'use strict';
const { db } = require('./db');
const { getStock } = require('./stock');
const { sendEmail } = require('./mailer');

const MAX_ATTEMPTS = 20;
const STALE_SENDING_MS = 2 * 60 * 1000;
const CONCURRENCY = 5;

const claimStmt = db.prepare(`
  UPDATE requests
     SET status = 'sending', send_started_at = ?, attempts = attempts + 1
   WHERE status = 'pending' AND sku = ? AND next_attempt_at <= ?
  RETURNING id, email, sku, attempts`);
const markSent = db.prepare(`UPDATE requests SET status='notified', notified_at=?, message_id=?, last_error=NULL WHERE id=? AND status='sending'`);
const markRetry = db.prepare(`UPDATE requests SET status='pending', next_attempt_at=?, last_error=? WHERE id=? AND status='sending'`);
const markFailed = db.prepare(`UPDATE requests SET status='failed', last_error=? WHERE id=? AND status='sending'`);
const countDue = db.prepare(`SELECT COUNT(*) AS c FROM requests WHERE sku=? AND status='pending' AND next_attempt_at<=?`);
const setName = db.prepare(`UPDATE requests SET product_name=? WHERE id=?`);

const inflight = new Set();
const rerun = new Set();

/**
 * Notify everyone waiting on `sku`, but only after confirming with the stock API.
 * The webhook is a hint; the stock API is the source of truth.
 * Safe to call any number of times, concurrently: rows are claimed atomically.
 */
async function processSku(sku) {
  if (inflight.has(sku)) { rerun.add(sku); return; }
  inflight.add(sku);
  try {
    if (countDue.get(sku, Date.now()).c === 0) return;
    const stock = await getStock(sku);
    if (!stock || !stock.inStock) return;

    const claimed = claimStmt.all(Date.now(), sku, Date.now());
    let i = 0;
    const lane = async () => {
      while (i < claimed.length) {
        const row = claimed[i++];
        await deliver(row, stock);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claimed.length) }, lane));
  } catch (e) {
    console.error(`[worker] sku=${sku}:`, e.message); // rows stay 'pending'; the sweep retries
  } finally {
    inflight.delete(sku);
    if (rerun.delete(sku)) setImmediate(() => processSku(sku));
  }
}

async function deliver(row, stock) {
  try {
    if (stock.name) setName.run(stock.name, row.id);
    // Same key for every attempt of this request: a retry after a timeout or crash can't double-send.
    const messageId = await sendEmail({ to: row.email, product: stock, idempotencyKey: `back-in-stock-req-${row.id}` });
    markSent.run(Date.now(), messageId, row.id);
  } catch (e) {
    const retry = e.retryable !== false && row.attempts < MAX_ATTEMPTS;
    if (retry) {
      const backoff = Math.min(10 * 60_000, 5_000 * 2 ** (row.attempts - 1));
      markRetry.run(Date.now() + backoff, String(e.message).slice(0, 300), row.id);
    } else {
      markFailed.run(String(e.message).slice(0, 300), row.id);
    }
    console.error(`[worker] request ${row.id} send failed (attempt ${row.attempts}, ${retry ? 'will retry' : 'giving up'}): ${e.message}`);
  }
}

/** Rows stuck in 'sending' mean we crashed mid-send. Put them back; the idempotency key keeps this safe. */
function recoverStale({ all = false } = {}) {
  const cutoff = all ? Date.now() + 1 : Date.now() - STALE_SENDING_MS;
  const r = db.prepare(`UPDATE requests SET status='pending', next_attempt_at=0, last_error='recovered after interrupted send' WHERE status='sending' AND send_started_at < ?`).run(cutoff);
  if (r.changes) console.log(`[worker] recovered ${r.changes} interrupted send(s)`);
}

/** Safety net for dropped webhooks and downtime: re-check every SKU that has someone waiting. */
async function sweep() {
  try {
    recoverStale();
    const skus = db.prepare(`SELECT DISTINCT sku FROM requests WHERE status='pending' AND next_attempt_at <= ?`).all(Date.now()).map((r) => r.sku);
    let i = 0;
    const lane = async () => { while (i < skus.length) await processSku(skus[i++]); };
    await Promise.all(Array.from({ length: Math.min(4, skus.length) }, lane));
  } catch (e) {
    console.error('[sweep]', e.message);
  }
}

function start(intervalMs = 30_000) {
  recoverStale({ all: true }); // single instance: anything 'sending' at boot is from a previous run
  setTimeout(sweep, 1000);
  const t = setInterval(sweep, intervalMs);
  t.unref();
  return t;
}

module.exports = { processSku, sweep, start };
