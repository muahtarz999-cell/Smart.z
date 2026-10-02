# Smart.z WhatsApp QR Connection Service

This is a persistent Node.js service, separate from the Cloudflare Pages app and from Meta Embedded Signup. It only owns QR session lifecycle; it does not read, send, or persist WhatsApp messages.

The engine is `@whiskeysockets/baileys`, a community implementation of the WhatsApp multi-device Web protocol, not an official Meta SDK. WhatsApp may change the protocol or restrict accounts using unofficial clients. Run one service replica with a durable private volume; do not scale this in-memory SessionManager horizontally without adding distributed ownership/locking.

## Runtime configuration

Set these in the service host's secret/environment settings:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side only; never expose it to Smart.z clients)
- `SESSION_ENCRYPTION_KEY` (random secret, at least 32 bytes)
- `SMARTZ_ORIGIN` (the exact Smart.z origin allowed by CORS)
- `WHATSAPP_SESSION_DIR` (persistent mounted volume, default `/var/lib/smartz-whatsapp`)
- `PORT` (default `8788`)

Set `NEXT_PUBLIC_WHATSAPP_CONNECTION_SERVICE_URL` for the Smart.z frontend to the HTTPS base URL of this service.

The service validates each Supabase access token with Supabase Auth before deriving `user_id`. Its service-role client is only used on this server, and every database operation is explicitly scoped to that verified user and connection. Baileys auth state is encrypted at rest with AES-256-GCM; keep the mounted volume and `SESSION_ENCRYPTION_KEY` durable and backed up together.

The central Smart.z access gate requires a `public.customer_registry` row with `account_status = active` and `start_date <= today`. Auth signups are inserted as `pending`; activation must be performed by a trusted operator. `end_date` is recorded but intentionally not enforced yet.

## Lifecycle API

All routes require `Authorization: Bearer <Supabase access token>`:

- `GET /api/whatsapp/status`
- `POST /api/whatsapp/session`
- `POST /api/whatsapp/reconnect`
- `POST /api/whatsapp/disconnect`
- `DELETE /api/whatsapp/session`

Only the current user's QR data URL and public connection status are returned. QR data is memory-only and expires; authentication state remains in the encrypted service volume.

Expected table columns used by this service are `id`, `user_id`, `connection_type`, and `status` on `public.whatsapp_connections`; `user_id`, `connection_id`, `event_type`, and `metadata` on `public.whatsapp_connection_events`. The secret table is not used because Baileys stores its encrypted multi-device auth state in the private service volume rather than an access token. Confirm these column names against the deployed schema before enabling the service.