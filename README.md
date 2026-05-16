# Portfulo-Worker-Push

Cloudflare Worker that watches Supabase row events on `portfolio_data`
and posts APNS push notifications to the user's iOS devices.

Phase B scope (current): one banner per INSERT, generic payload, source
device exclusion, dead-token cleanup. Future phases add coalescing
(C), per-category preferences + quiet hours (D), retries + rate limits
(E), tap-through deep links + per-device list (F).

## Deploy (first time)

```sh
# 1. Install dependencies + log in to Cloudflare
npm install
npx wrangler login

# 2. Set all secrets (each command prompts for the value)
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_BUNDLE_ID
npx wrangler secret put WEBHOOK_SECRET            # pick a random string
# Paste the .p8 file's full contents (including PEM header/footer):
npx wrangler secret put APNS_PRIVATE_KEY

# 3. Deploy
npx wrangler deploy

# 4. Verify
curl https://portfulo-push.<your>.workers.dev/health
# → "ok"
```

Note the deployed URL — Cloudflare prints it after `deploy`.

## Wire the Supabase Database Webhook

1. Supabase Dashboard → **Database** → **Webhooks** → **Create a new hook**.
2. Name: `push-on-portfolio-data`.
3. Table: `portfolio_data`.
4. Events: tick **Insert** only.
5. Type: **HTTP Request**.
6. Method: **POST**.
7. URL: `https://portfulo-push.<your>.workers.dev/webhook`
8. HTTP Headers — add one:
   - Key: `x-portfulo-webhook-secret`
   - Value: the same string you used for `WEBHOOK_SECRET` above
9. Save.

## Tail logs

```sh
npx wrangler tail
```

Insert a row in `portfolio_data` from a non-active device, watch the
log lines:

```
[push] Sent to 1/1 (portfolio=… dataType=transactions gone=0 bad=0 server=0 other=0)
```

If you see nothing, the webhook didn't fire — re-check the URL +
header in Supabase. If you see `Unauthorized`, the WEBHOOK_SECRET
doesn't match.

## Local dev

```sh
cp .dev.vars.example .dev.vars   # fill in real values
npx wrangler dev --local
```

Send a fake webhook to `http://localhost:8787/webhook`:

```sh
curl -X POST http://localhost:8787/webhook \
  -H "x-portfulo-webhook-secret: $(grep WEBHOOK_SECRET .dev.vars | cut -d= -f2)" \
  -H "content-type: application/json" \
  -d '{
    "type": "INSERT",
    "table": "portfolio_data",
    "schema": "public",
    "record": {
      "id": "00000000-0000-0000-0000-000000000000",
      "portfolio_id": "<your real portfolio id>",
      "data_type": "transactions",
      "updated_by_device": "some-other-device-id",
      "updated_at": "2026-05-16T00:00:00Z"
    },
    "old_record": null
  }'
```

A real device with `is_active = true` and a different `device_id`
should receive a banner within ~2 seconds.
