# githook-relay-worker

Cloudflare Worker that receives GitHub push webhooks and broadcasts them over WebSockets to [gitea-notifier](../gitea-notifier/README.md).

Configure `GITHUB_WEBHOOK_SECRET` and a separate, high-entropy `GITHUB_RELAY_WEBSOCKET_SECRET` with `wrangler secret put GITHUB_WEBHOOK_SECRET` and `wrangler secret put GITHUB_RELAY_WEBSOCKET_SECRET` (or in `.dev.vars` for local development).

For coordinated infrastructure, Access policy, secret and Worker deployments, use the [Terraform/Wrangler deployment project](../cloudflare-relay-access-policy-terraform/README.md).

The default relay paths below are configured as runtime text bindings in [wrangler.toml](./wrangler.toml): `CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH` and `CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH`. Both the Worker and Durable Object read these values through `Env::var`. The deployment wrapper overrides them from its dotenv/CI inputs and uses the same values for Access application domains and destinations. No compile-time substitution is needed. Missing or invalid bindings produce a logged 500 error on relay requests rather than falling back to an unprotected default path.

Use distinct, non-nested, non-root paths with nonempty ASCII URL-unreserved segments (`A-Z`, `a-z`, digits, `-._~`), without trailing slashes, dot segments or percent encoding. When deploying without the wrapper, update Wrangler's `[vars]` and the corresponding Access applications together. Changing paths does not require a Durable Object migration; update webhook/client URLs after deployment.

Send JSON push and ping events to `POST /relay/webhooks/github/push`. The Durable Object verifies `x-hub-signature-256` against the raw body before parsing the payload. A valid ping returns 200 without sending a WebSocket message; only pushes are broadcast. Missing or invalid signatures return 403; malformed payloads or unsupported event types return 400. The GitHub hook ID is not required for routing.

Connect to `wss://<worker-host>/relay/ws` with an `Authorization: Bearer <secret>` header using the `GITHUB_RELAY_WEBSOCKET_SECRET` value. Every authenticated connection receives all verified pushes, regardless of which GitHub webhook delivered them. The single broadcast Durable Object coordinates all connections; this centralizes traffic and can become a throughput bottleneck at high volume. Delivery is live/best-effort: pushes received with no connected clients are not queued, and failed sends are logged. The `/` placeholder route remains available without a webhook secret.
