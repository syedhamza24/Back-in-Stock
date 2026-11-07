'use strict';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function render(product) {
  const name = product.name || product.sku;
  const low = product.quantity != null && product.quantity > 0 && product.quantity <= 10;
  const cta = product.url || process.env.STORE_URL || null;
  const subject = `${name} is back in stock`;
  const preheader = `You asked us to let you know. ${name} is available again.`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f4f6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f6;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;">
${product.image ? `<tr><td><img src="${esc(product.image)}" alt="${esc(name)}" width="520" style="display:block;width:100%;height:auto;border:0;"></td></tr>` : ''}
<tr><td style="padding:32px 28px 8px;font-family:${FONT};color:#16202a;">
<div style="display:inline-block;background:#e3f4ec;color:#0b6e4f;font-size:13px;font-weight:600;padding:5px 10px;border-radius:999px;">Back in stock</div>
<h1 style="margin:16px 0 8px;font-size:26px;line-height:1.25;font-weight:700;color:#16202a;">${esc(name)} is available again</h1>
<p style="margin:0 0 8px;font-size:16px;line-height:1.55;color:#3b4754;">You asked us to email you when this item returned. It's ready to order now.</p>
${low ? `<p style="margin:0 0 8px;font-size:16px;line-height:1.55;color:#3b4754;"><strong>Only ${esc(product.quantity)} left</strong>, so it may sell out again soon.</p>` : ''}
</td></tr>
${cta ? `<tr><td style="padding:16px 28px 8px;font-family:${FONT};">
<a href="${esc(cta)}" style="display:block;text-align:center;background:#0b6e4f;color:#ffffff;text-decoration:none;font-size:17px;font-weight:600;padding:16px 20px;border-radius:8px;">View ${esc(name)}</a></td></tr>` : ''}
<tr><td style="padding:24px 28px 32px;font-family:${FONT};font-size:13px;line-height:1.5;color:#6b7785;">
Item code: ${esc(product.sku)}<br>This is a one-time alert. You won't get more emails about this request.
</td></tr></table></td></tr></table></body></html>`;
  const text = `${name} is back in stock\n\nYou asked us to email you when this item returned. It's ready to order now.${low ? `\nOnly ${product.quantity} left.` : ''}\n${cta ? `\n${cta}\n` : ''}\nItem code: ${product.sku}\nThis is a one-time alert. You won't get more emails about this request.\n`;
  return { subject, html, text };
}

class SendError extends Error {
  constructor(msg, retryable) { super(msg); this.retryable = retryable; }
}

async function sendEmail({ to, product, idempotencyKey }) {
  const base = (process.env.RESEND_BASE_URL || 'https://api.resend.com').replace(/\/+$/, '');
  const { subject, html, text } = render(product);
  let res;
  try {
    res = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY || ''}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || 'Stock Alerts <alerts@resend.dev>',
        to: [to],
        subject,
        html,
        text,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new SendError(`network: ${e.message}`, true); // retry is safe: same idempotency key
  }
  const body = await res.text();
  if (res.ok) {
    try { return JSON.parse(body).id || null; } catch { return null; }
  }
  const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
  throw new SendError(`resend ${res.status}: ${body.slice(0, 200)}`, retryable);
}

module.exports = { sendEmail, render, esc };
