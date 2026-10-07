# githook-relay-worker

Cloudflare Worker that receives GitHub push webhooks and broadcasts them over WebSockets to [gitea-notifier](../gitea-notifier/README.md).

Configure `GITHUB_WEBHOOK_SECRET` and a separate, high-entropy `GITHUB_RELAY_WEBSOCKET_SECRET` with `wrangler secret put GITHUB_WEBHOOK_SECRET` and `wrangler secret put GITHUB_RELAY_WEBSOCKET_SECRET` (or in `.dev.vars` for local development).

Send JSON push and ping events to `POST /webhooks/github/push`. The Durable Object verifies `x-hub-signature-256` against the raw body before parsing the payload. A valid ping returns 200 without sending a WebSocket message; only pushes are broadcast. Missing or invalid signatures return 403; malformed payloads or unsupported event types return 400. The GitHub hook ID is not required for routing.

Connect to `wss://<worker-host>/relay/ws` with an `Authorization: Bearer <secret>` header using the `GITHUB_RELAY_WEBSOCKET_SECRET` value. Every authenticated connection receives all verified pushes, regardless of which GitHub webhook delivered them. The single broadcast Durable Object coordinates all connections; this centralizes traffic and can become a throughput bottleneck at high volume. Delivery is live/best-effort: pushes received with no connected clients are not queued, and failed sends are logged. The `/` placeholder route remains available without a webhook secret.
