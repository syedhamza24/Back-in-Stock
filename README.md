# Back-in-stock alerts

Customers ask to be emailed when a sold-out item returns. This service takes the request, watches stock, and sends one email.

**Stack:** Node 22, Express, SQLite (built-in `node:sqlite`, no native modules). One container, one file of state.

## Run

```bash
docker build -t back-in-stock .
docker run -p 3000:3000 \
  -e STOCK_API_URL=... -e STOCK_API_KEY=... \
  -e RESEND_API_KEY=... -e RESEND_BASE_URL=... \
  -e WEBHOOK_SECRET=... \
  -v bis-data:/data \
  back-in-stock
```

It listens on `$PORT` (default 3000). Mount a volume at `/data` to keep data across container replacements; without one it still survives process restarts, but not a new container.

| Variable | Required | Purpose |
|---|---|---|
| `STOCK_API_URL`, `STOCK_API_KEY` | yes | Source of truth for stock. Bearer auth. |
| `RESEND_API_KEY`, `RESEND_BASE_URL` | yes | Email is sent to `{RESEND_BASE_URL}/emails`. |
| `WEBHOOK_SECRET` | yes | Checked against `X-Webhook-Secret`. |
| `ADMIN_PASSWORD` | no | Password for `/admin` (any username). **Falls back to `WEBHOOK_SECRET`** so the app works with only the variables above. |
| `FROM_EMAIL` | no | Sender, default `Stock Alerts <alerts@resend.dev>`. |
| `STORE_URL` | no | Link for the email button when the stock API gives no product URL. |
| `PORT`, `DATA_DIR` | no | Default `3000`, `/data` in Docker. |

## Endpoints

- `GET /embed`: email + SKU form. Framable from any origin (`frame-ancestors *`). Accepts `?sku=` and `?email=` to prefill.
- `POST /api/requests` `{ email, sku }`: `201` created, `200` with `already_requested: true` if an open request exists, `400` invalid input, `404` unknown SKU, `503` stock API unreachable.
- `POST /webhooks/stock`: `{ event_id, sku, quantity }` with `X-Webhook-Secret`.
- `GET /admin`: HTTP Basic. Every request with its status, when it was notified, attempts and last error. Filter by status.
- `GET /healthz`

## How customers get exactly one email

**No duplicate requests.** A partial unique index on `(email, sku)` for open requests (`pending`/`sending`) makes the database reject duplicates, so parallel submissions can't race past an application-level check. Emails are lowercased and trimmed first. After a customer is notified they can ask again.

**Don't trust the webhook.** The secret is compared in constant time, the payload is validated, and the quantity in the webhook is treated only as a hint. Before sending anything we call the stock API and require the item to really be in stock. A fake or stale webhook sends nothing.

**Duplicate and concurrent webhooks.** `event_id` is a primary key, so exactly one of N simultaneous deliveries is processed and the rest get a `200` immediately. Even if two *different* events arrive for the same SKU, rows are claimed with a single atomic `UPDATE ... WHERE status='pending' ... RETURNING`, so a request can only be claimed once.

**Never zero emails.**
- State is in SQLite (WAL), so a restart loses nothing.
- A sweep runs every 30 seconds and re-checks the stock API for every SKU that has someone waiting. A webhook that never arrived, or arrived while we were down, is still caught.
- Failed sends go back to `pending` with exponential backoff (up to 20 attempts); permanent errors (4xx) are marked `failed` and shown in the admin.
- On boot, anything stuck in `sending` from a crash is put back in the queue.

**Never two emails after a crash or timeout.** Every send uses an `Idempotency-Key` of `back-in-stock-req-{id}`, identical across retries, so a retry after a timeout or a crash between "sent" and "saved" is deduplicated by the email provider. The remaining edge case is a provider that ignores idempotency keys, where a crash in that single window could repeat one email.

## Tests

```bash
npm install && npm test
```

Starts a fake stock API and fake Resend, then checks: duplicate requests, parallel requests, bad secret, bad payload, a lying webhook, 25 concurrent webhooks sending exactly the right emails, retry on send failure, and restart with a missed webhook.
