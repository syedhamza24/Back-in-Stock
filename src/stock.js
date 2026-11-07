'use strict';

const BASE = () => (process.env.STOCK_API_URL || '').replace(/\/+$/, '');
const headers = () => ({ Authorization: `Bearer ${process.env.STOCK_API_KEY || ''}`, Accept: 'application/json' });

async function getJSON(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(5000) });
      if (res.status === 404) return { notFound: true };
      if (!res.ok) throw new Error(`stock api ${res.status}`);
      return { data: await res.json() };
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 250 * 2 ** i));
    }
  }
  throw lastErr;
}

function normalise(d, fallbackSku) {
  const quantity = Number.isFinite(Number(d.quantity)) && d.quantity !== null ? Number(d.quantity) : null;
  const inStock = typeof d.in_stock === 'boolean' ? d.in_stock && (quantity === null || quantity > 0) : (quantity || 0) > 0;
  const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : null);
  return {
    sku: String(d.sku || fallbackSku),
    name: d.name || d.title || null,
    quantity,
    inStock,
    url: httpUrl(d.url),
    image: httpUrl(d.image) || httpUrl(d.image_url),
    price: d.price ?? null,
  };
}

/** Authoritative stock lookup. Returns null if the SKU doesn't exist; throws if the API is unreachable. */
async function getStock(sku) {
  const r = await getJSON(`${BASE()}/${encodeURIComponent(sku)}`);
  if (r.notFound) return null;
  return normalise(r.data, sku);
}

async function getCatalogue() {
  const r = await getJSON(BASE(), 2);
  const d = r.data || {};
  const list = Array.isArray(d) ? d : d.products || d.items || d.data || d.catalogue || [];
  return list.filter((p) => p && (p.sku || p.id)).map((p) => normalise({ ...p, sku: p.sku || p.id }, p.sku || p.id));
}

module.exports = { getStock, getCatalogue };
