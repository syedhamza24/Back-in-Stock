'use strict';
const { esc } = require('./mailer');

const embedPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email me when it's back</title>
<style>
  :root{--ink:#16202a;--muted:#5d6a77;--line:#c9d1d9;--accent:#0b6e4f;--accent-d:#095a41;--err:#b42318;--ok-bg:#e3f4ec}
  *{box-sizing:border-box}
  html,body{margin:0;background:transparent}
  body{font:16px/1.5 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--ink);padding:4px}
  h1{font-size:20px;line-height:1.3;margin:0 0 4px}
  p.sub{margin:0 0 16px;color:var(--muted);font-size:15px}
  label{display:block;font-weight:600;font-size:14px;margin:0 0 6px}
  .field{margin-bottom:14px}
  input{width:100%;height:48px;padding:0 14px;font:inherit;color:var(--ink);background:#fff;border:1.5px solid var(--line);border-radius:8px}
  input:focus-visible,button:focus-visible{outline:3px solid #7cc4a8;outline-offset:1px;border-color:var(--accent)}
  input[aria-invalid="true"]{border-color:var(--err)}
  button{width:100%;height:48px;font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:8px;cursor:pointer}
  button:hover{background:var(--accent-d)}
  button[disabled]{opacity:.65;cursor:progress}
  .msg{margin-top:14px;padding:12px 14px;border-radius:8px;font-size:15px}
  .msg.ok{background:var(--ok-bg);color:#0a4d37}
  .msg.err{background:#fdecea;color:var(--err)}
  .msg[hidden]{display:none}
  @media (prefers-reduced-motion:no-preference){button{transition:background .15s}}
</style></head>
<body>
<form id="f" novalidate>
  <h1>Get an email when it's back</h1>
  <p class="sub">We'll send one email as soon as this item is in stock again.</p>
  <div class="field"><label for="email">Email address</label>
    <input id="email" name="email" type="email" inputmode="email" autocomplete="email" maxlength="254" required placeholder="you@example.com"></div>
  <div class="field"><label for="sku">Item code (SKU)</label>
    <input id="sku" name="sku" list="skus" autocapitalize="characters" autocomplete="off" maxlength="64" required>
    <datalist id="skus"></datalist></div>
  <button id="btn" type="submit">Notify me</button>
  <div id="msg" class="msg" role="status" aria-live="polite" hidden></div>
</form>
<script>
(function(){
  var f=document.getElementById('f'),email=document.getElementById('email'),sku=document.getElementById('sku'),
      btn=document.getElementById('btn'),msg=document.getElementById('msg');
  var q=new URLSearchParams(location.search);
  if(q.get('sku')) sku.value=q.get('sku');
  if(q.get('email')) email.value=q.get('email');

  fetch('/api/catalogue').then(function(r){return r.ok?r.json():[]}).then(function(list){
    var dl=document.getElementById('skus');
    list.filter(function(p){return !p.inStock}).forEach(function(p){
      var o=document.createElement('option'); o.value=p.sku; o.label=p.name||p.sku; dl.appendChild(o);
    });
  }).catch(function(){});

  function show(kind,text){msg.hidden=false;msg.className='msg '+kind;msg.textContent=text}
  f.addEventListener('submit',function(e){
    e.preventDefault();
    msg.hidden=true; email.removeAttribute('aria-invalid'); sku.removeAttribute('aria-invalid');
    var em=email.value.trim(), sk=sku.value.trim();
    if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(em)){email.setAttribute('aria-invalid','true');email.focus();return show('err','Enter a valid email address, like you@example.com.')}
    if(!sk){sku.setAttribute('aria-invalid','true');sku.focus();return show('err','Enter the item code of the product you want.')}
    btn.disabled=true; btn.textContent='Saving...';
    fetch('/api/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:em,sku:sk})})
      .then(function(r){return r.json().catch(function(){return {}}).then(function(b){return {s:r.status,b:b}})})
      .then(function(x){
        if(x.s===201) show('ok',"You're on the list. We'll email "+em+" as soon as it's back in stock.");
        else if(x.s===200) show('ok',"You're already on the list for this item. We'll email "+em+" when it's back.");
        else { if(x.s===404) sku.setAttribute('aria-invalid','true'); show('err',x.b.error||'Something went wrong. Try again in a moment.'); }
      })
      .catch(function(){show('err',"Couldn't reach the server. Check your connection and try again.")})
      .then(function(){btn.disabled=false;btn.textContent='Notify me'});
  });
})();
</script></body></html>`;

const fmt = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '-');
const FILTERS = ['all', 'pending', 'sending', 'notified', 'failed'];

function adminPage({ rows, counts, filter, total }) {
  const chip = (f) => `<a class="chip${f === filter ? ' on' : ''}" href="/admin?status=${f}">${f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)} <b>${f === 'all' ? total : counts[f] || 0}</b></a>`;
  const body = rows.length
    ? rows.map((r) => `<tr>
        <td>${r.id}</td><td>${esc(r.email)}</td>
        <td>${esc(r.product_name || '')}<div class="sku">${esc(r.sku)}</div></td>
        <td><span class="pill ${r.status}">${r.status}</span>${r.last_error && r.status !== 'notified' ? `<div class="err" title="${esc(r.last_error)}">${esc(r.last_error)}</div>` : ''}</td>
        <td>${fmt(r.created_at)}</td><td>${fmt(r.notified_at)}</td><td>${r.attempts}</td></tr>`).join('')
    : `<tr><td colspan="7" class="empty">No requests${filter === 'all' ? ' yet. They appear here as soon as customers sign up.' : ' with this status.'}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15"><title>Stock alert requests</title>
<style>
  :root{--ink:#16202a;--muted:#5d6a77;--line:#dde3e9;--accent:#0b6e4f}
  *{box-sizing:border-box}
  body{margin:0;background:#f6f8fa;color:var(--ink);font:15px/1.45 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  header{padding:24px clamp(16px,4vw,40px) 8px}
  h1{margin:0 0 4px;font-size:24px}
  .sub{color:var(--muted);margin:0 0 16px}
  .chips{display:flex;flex-wrap:wrap;gap:8px}
  .chip{padding:7px 12px;border:1.5px solid var(--line);border-radius:999px;color:var(--ink);text-decoration:none;background:#fff}
  .chip.on{border-color:var(--accent);background:#e3f4ec}
  .chip:focus-visible{outline:3px solid #7cc4a8}
  .wrap{margin:16px clamp(16px,4vw,40px) 40px;overflow-x:auto;background:#fff;border:1px solid var(--line);border-radius:10px}
  table{border-collapse:collapse;width:100%;min-width:760px}
  th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:13px;color:var(--muted);font-weight:600;background:#fbfcfd}
  tr:last-child td{border-bottom:0}
  .sku{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--muted)}
  .err{font-size:12px;color:#b42318;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:13px;font-weight:600}
  .pending{background:#fff3d6;color:#7a5200}.sending{background:#dfeaff;color:#1a4aa8}
  .notified{background:#e3f4ec;color:#0a4d37}.failed{background:#fdecea;color:#b42318}
  .empty{text-align:center;color:var(--muted);padding:40px}
</style></head><body>
<header><h1>Stock alert requests</h1><p class="sub">Updates every 15 seconds. Showing the latest 500.</p>
<nav class="chips" aria-label="Filter by status">${FILTERS.map(chip).join('')}</nav></header>
<div class="wrap"><table><thead><tr><th>ID</th><th>Email</th><th>Product</th><th>Status</th><th>Requested</th><th>Notified</th><th>Attempts</th></tr></thead><tbody>${body}</tbody></table></div>
</body></html>`;
}

module.exports = { embedPage, adminPage, FILTERS };
