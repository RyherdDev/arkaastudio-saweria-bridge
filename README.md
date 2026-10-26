# Arkaa Saweria Bridge

Node.js bridge for receiving verified Saweria HTTP webhooks and exposing a protected queue API for Roblox.

## Files
- `server.js` — webhook verification, SQLite queue, Roblox polling and acknowledgement endpoints.
- `package.json` — dependencies and start command.
- `.gitignore` — excludes local secrets and database files.

## Required environment variables
- `SAWERIA_STREAM_KEY`: Saweria stream key used to verify `Saweria-Callback-Signature`.
- `BRIDGE_SECRET`: separate random secret, at least 32 UTF-8 bytes, shared with the Roblox server script.
- `DB_PATH`: use `/var/data/saweria.sqlite` on Render when a persistent disk is mounted at `/var/data`.
- `PORT`: supplied by the hosting platform.

## Render
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- Attach a persistent disk mounted at `/var/data` and set `DB_PATH=/var/data/saweria.sqlite`.
- Add secrets only in the Render Environment dashboard. Never commit `.env`.

## Endpoints
- `GET /health` — health check.
- `POST /saweria/webhook` — configure this URL in Saweria's HTTP Webhook settings.
- `GET /roblox/poll` — protected with `x-bridge-secret`.
- `POST /roblox/ack` — protected with `x-bridge-secret`; JSON body: `{"ids":["transaction-id"]}`.

## Important production notes
1. Test signature verification using a genuine Saweria test callback before accepting real donations.
2. Saweria's documented signature payload is the ordered concatenation of `version`, `id`, `amount_raw`, `donator_name`, and `donator_email`, signed with HMAC-SHA256 using the stream key.
3. Queue acknowledgement is not an exactly-once guarantee for effects across multiple Roblox servers. Roblox must independently implement idempotent transaction processing and safe retry handling.
4. The API secret must only be used by Roblox server-side code, never a LocalScript or replicated client configuration.
5. Use persistent storage. Render's default filesystem is ephemeral.
