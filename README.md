# github-relay-cloudflare  
A relay system for using a cloudflare worker to receive github 'push' event webhooks and relay them to a private server over a websocket \([githook-relay-worker](./githook-relay-worker/README.md)\). The receiving program instructs gitea to sync the repository mirror immediately after a push \([gitea-notifier](./gitea-notifier/README.md)\).

Deploy the Worker, Durable Object migrations, IP lists and path-specific Access policies together with the [Terraform/Wrangler deployment project](./cloudflare-relay-access-policy-terraform/README.md).