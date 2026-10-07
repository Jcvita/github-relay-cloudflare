# gitea-notifier

Receives GitHub push events from the Cloudflare relay over an authenticated WebSocket and prints the parsed event. Triggering a Gitea mirror sync is not implemented yet.

Set these environment variables, or copy `.env.example` to `.env` in this directory and set them there (process environment variables take precedence):

- `WEBSOCKET_URL`: the full WebSocket URL, `wss://<host>/relay/ws` (for example, `wss://your-worker.example.workers.dev/relay/ws`). This stream receives pushes from all GitHub webhooks. Use `ws://` only for local development.
- `GITHUB_RELAY_WEBSOCKET_SECRET`: the shared secret sent as `Authorization: Bearer <secret>` on the `GET` WebSocket upgrade handshake. Set the Worker's `GITHUB_RELAY_WEBSOCKET_SECRET` binding to the same value. Do not commit `.env` (it is gitignored).

Run from this directory with `cargo run`. A `.env` file is optional when both variables are set in the process environment. The notifier logs malformed payloads without stopping, retries dropped connections with backoff (1-30 seconds), and prints each decoded push event. Run `cargo test` for the focused tests.
