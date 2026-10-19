# Relay infrastructure and deployment

Reusable **Terraform + Wrangler** deployment for the existing Rust [relay Worker](../githook-relay-worker/) and the resources configured by the [Python provisioner](../cloudflare-relay-access-policy-script/).

```text
GitHub /meta .hooks ----> Zero Trust list --> Service Auth policy --> Access app: hostname/relay/webhooks/github/push
Gitea public egress ----> Zero Trust list --> Service Auth policy --> Access app: hostname/relay/ws

Wrangler --> Rust/Wasm Worker --> GITHUB_HOOK_RELAY --> SQLite GithubHookRelay (existing migration history)
         \-> selected public hostname, no preview URLs
```

Terraform owns six resources: two Zero Trust lists, two reusable Access policies and two path-specific self-hosted Access applications. Wrangler owns the Worker code, bindings, migrations, runtime secrets and hostname routing. Neither tool manages resources owned by the other. Rules custom lists are not created, updated, adopted or verified.

## Important differences from the Python script

- **Rules lists and Zero Trust lists are different API resources.** The script creates `/rules/lists`, but Access `ip_list` selectors use `/gateway/lists`. This project manages only the Zero Trust lists that Access uses. Never use a Rules list ID as a Zero Trust list ID. The separate Rules-list quota does not constrain these Zero Trust lists.
- Policies use **Service Auth** (`non_identity`), not the script's `allow`. This deliberately permits IP-matching machine clients without an IdP login, while retaining Access enforcement and logging. Nonmatching sources are denied. The Worker still independently checks GitHub HMAC signatures and the WebSocket bearer secret.
- The default webhook path is **`/relay/webhooks/github/push`**, not `/webhooks/github/push` from the old example. Set `CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH` and `CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH` to change both the Worker routes and their Access destinations together.
- Applications enforce exactly one destination and their own policy. Existing extra policy links, include/require/exclude rules, destinations and manually added list entries are reconciled to this configuration. Review adoption plans carefully, especially for resources shared with other applications.

Do not keep running the Python provisioner against these resources after adoption: it can restore the old policy decision and wrong list references.

## Prerequisites

- Node.js **22.16+**, npm, and Terraform **1.7+ / <2**.
- The source Worker's existing Rust build prerequisites: Cargo, the `wasm32-unknown-unknown` target, and the nightly toolchain/rust-src required by its `--panic-unwind` build. The wrapper reuses the source `wrangler.toml` build command rather than maintaining a separate Rust build recipe.
- A Cloudflare account with Zero Trust configured and SQLite Durable Objects available.
- For `custom_domain`: an active Cloudflare zone in that account and an available hostname. Workers custom domains provision routing/DNS/TLS through Wrangler; do not create an additional origin DNS record for the same hostname.
- For `workers_dev`: an already registered account subdomain. The configured hostname must be exactly `<worker_name>.<account_subdomain>.workers.dev`; the wrapper verifies it through the API.

The API token needs account-scoped **Workers Scripts: Edit**, **Zero Trust: Edit** and **Access: Apps and Policies: Edit**, with corresponding read access for discovery/verification. Custom domains additionally need **Workers Routes: Edit** and **Zone: Read** for the selected zone. **Account Filter Lists: Edit** is no longer needed to manage the relay resources. Restrict the token to the intended account and zone. Cloudflare's dashboard/API may label write permissions as “Write” rather than “Edit”.

The pinned Cloudflare provider, local Wrangler and TOML parser versions are recorded in [versions.tf](./versions.tf), [package.json](./package.json), and their generated lockfiles. Commit both lockfiles. No global Wrangler installation is used.

## Quick start (PowerShell)

```powershell
Set-Location .\cloudflare-relay-access-policy-terraform
npm ci
Copy-Item .env.example .env
# Edit .env with the real account, hostname, Gitea egress IPs and distinct secrets.

npm run dry-run
npm run plan
npm run deploy
```

`deploy` asks for Terraform's usual `yes` confirmation. For an already-reviewed configuration in CI:

```powershell
npm run deploy -- --yes
```

All commands can read a different dotenv file:

```powershell
npm run plan -- --env-file C:\secure\relay.env
npm run deploy -- --env-file C:\secure\relay.env --yes
```

Shell/CI environment variables override values from the dotenv file. No dotenv file is required when all values are supplied by the environment. `--yes` approves Terraform changes; it does not force a takeover of another Worker's custom domain.

### What each command does

| Command | Behavior |
| --- | --- |
| `npm run dry-run` | Validate config and relay paths, generate Wrangler config, build Rust/Wasm, and run `wrangler deploy --dry-run`. No Cloudflare token, Terraform state or runtime secrets required. |
| `npm run plan` | Check target account/hostname, initialize Terraform, discover existing resources and plan declarative imports and reconciliation. Reads remote APIs; does not deploy or import into state. |
| `npm run deploy` | Validate both secrets, build/package first, check target/discover resources, apply Terraform, upload the already-built Worker and both secrets together, then verify the deployed links. |
| `npm run verify` | Read Terraform's deployment output and Cloudflare APIs to verify list membership, Access rules and destinations, policy links, Worker bindings/secrets, SQLite namespace, migration tag, observability and routing/exposure. Does not apply or deploy. |

Access is applied **before** Wrangler publishes a public endpoint, including on the first deployment. This is a resumable pipeline, not an atomic transaction: if Worker deployment fails, Terraform changes remain, and rerunning reconciles from that point. A Worker upload never runs if the Terraform apply fails.

## Variables

[.env.example](./.env.example) lists all inputs. Applicable names from the Python provisioner are retained; legacy Rules-list IDs are no longer used:

| Environment input | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Shared provider/Wrangler/API credential. Never passed as a Terraform variable. |
| `CLOUDFLARE_ACCOUNT_ID` | Target account. |
| `CLOUDFLARE_ACCESS_APPLICATION_DOMAIN` | Hostname only, without scheme, port or path. |
| `GITEA_SERVER_PUBLIC_IPS` | Comma-separated IPv4/IPv6 addresses or CIDRs. Empty/malformed entries fail. Use the server's actual public egress addresses. |
| `CLOUDFLARE_{GITHUB,GITEA}_IP_LIST_ID` | Legacy **Rules** list IDs: unused. These may be removed from existing dotenv files; they will not adopt Rules lists. |
| `CLOUDFLARE_{GITHUB,GITEA}_IP_LIST_NAME` | Names of the managed Zero Trust lists. Retains the script-compatible `[a-z0-9_]+` naming convention. |
| `CLOUDFLARE_{GITHUB,GITEA}_AC_POLICY_{ID,NAME}` | Optional policy adoption IDs and desired names. |
| `CLOUDFLARE_{GITHUB,GITEA}_ACCESS_APPLICATION_{ID,NAME,PATH}` | Optional application adoption IDs, desired names and paths used by both Rust runtime routing and Access. |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook HMAC secret; required for deploy only. |
| `GITHUB_RELAY_WEBSOCKET_SECRET` | Separate WebSocket bearer secret; required for deploy only. |

Additional deployment inputs:

| Environment input | Default / purpose |
| --- | --- |
| `RELAY_ENDPOINT_MODE` | `custom_domain` or `workers_dev`; inferred from hostname if omitted. |
| `CLOUDFLARE_ZONE_ID` | Required for custom domains; unused for workers.dev. |
| `CLOUDFLARE_WORKER_NAME` | Defaults to the source Wrangler Worker name. **Keep the existing name to retain the namespace/data.** |
| `CLOUDFLARE_{GITHUB,GITEA}_ZERO_TRUST_IP_LIST_ID` | Optional existing Zero Trust list IDs; otherwise discovered by name. |
| `CLOUDFLARE_{GITHUB,GITEA}_IP_LIST_DESCRIPTION` | Optional desired descriptions. |
| `WORKER_PROJECT_DIR` | Source Worker directory, defaulting to the sibling `githook-relay-worker`. Relative paths resolve from this project. |
| `TERRAFORM_BIN` | Terraform executable name or full absolute executable path, including `terraform.exe` on Windows (not just its directory); defaults to `terraform`. |

The wrapper inherits `main`, build command, compatibility date, Durable Object bindings and the **complete migration history** directly from the existing source Wrangler config. It never rewrites source files or invents migration tags. Binding/class names remain fixed because the Rust code consumes them; they are checked rather than exposed as unsafe independent overrides. Future migrations must be appended in the source project. Do not reset, reorder or remove deployed migration tags.

### Configurable relay paths

For example, set these in your deployment dotenv file or CI environment:

```dotenv
CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH=/hooks/github
CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH=/connections/gitea
```

The wrapper writes those exact values into both Terraform's endpoint inputs and the generated Wrangler `vars` bindings. Cloudflare deploys the bindings with the Worker version; the Rust fetch handler reads them through `Env::var`, and the Durable Object reads the same bindings through its own `Env`. This is runtime configuration visible to Cloudflare, **not** a dependency on the deployment machine's environment at request time, a remote HTTP config lookup, or a Rust compile-time environment substitution. Unset path inputs inherit the defaults in the source [wrangler.toml](../githook-relay-worker/wrangler.toml); explicitly empty values are rejected.

Paths must be distinct and non-nested, begin with `/`, and contain nonempty ASCII URL-unreserved segments (`A-Z`, `a-z`, digits, `-._~`). Root, trailing slash, dot/dot-dot segments, repeated slashes, percent escapes, wildcards, queries and fragments are rejected so Worker routing and Access path matching cannot disagree through ambiguous configuration. Invalid or missing runtime bindings fail closed with a logged 500 error on relay requests; the Worker's existing root placeholder is unchanged.

Deployment verification checks each uploaded text binding against the corresponding Terraform Access path. Changing paths updates state-managed Access applications in place and uploads the new runtime bindings; it does not rename the Worker, change the Durable Object namespace, or add migrations. Once deployed, paths no longer configured return 404. Update the GitHub webhook URL and Gitea client's WebSocket URL to the new Terraform outputs.

Path changes are not atomic across Terraform and Wrangler: Access is applied first, then the Worker version. Plan a maintenance window or stop senders/clients until deployment and verification finish. If upload fails after Access changes, complete the deployment or restore the prior configuration; the old code can still serve its old paths until upload succeeds, while the old Access destinations may already have moved. Unmanaged overlapping/old Access applications must be reviewed separately.

### Custom domain versus workers.dev

With `custom_domain`, the generated Wrangler config attaches the hostname to the Worker and explicitly disables workers.dev. With `workers_dev`, no custom route is generated and workers.dev is enabled. **Preview URLs are disabled in both modes.**

Only the two actual relay routes are protected by these Access applications; the existing `/` placeholder is unchanged. The Worker rejects other paths. Do not add alternate hostnames/routes or deploy the original standalone Wrangler config without equivalent Access protection. Manually configured alternate routes and other account-wide Access applications are outside this project's ownership; audit those before migration or switching endpoint modes.

## Adoption, repeatability and state

1. Existing Terraform state IDs take precedence for already-managed instances. For unmanaged resources, explicit IDs take precedence over exact-name discovery (exact domain/path for applications).
2. Duplicate matches, nonexistent explicit IDs, wrong list types and foreign account/zone/hostname targets abort rather than guessing. Applications already identified by state or explicit ID may change paths on the same hostname. If a resource was already deleted remotely, Terraform can recreate it.
3. Declarative Terraform `import` blocks adopt discovered IDs during apply. Imports are no-ops for resources already in state; subsequent applies update in place and do not create duplicates.
4. Both Zero Trust list memberships are authoritative. GitHub ranges come from the **`hooks` array only** at `https://api.github.com/meta`, fetched on every normal plan/apply using the HTTP provider. Missing/empty/malformed data or unsuccessful responses block the plan, rather than emptying a list or falling back to stale data. IPv4 and IPv6 are retained and duplicates removed.
5. There is no daemon or scheduled deployment here. Schedule `npm run deploy -- --yes`, or an infrastructure-only Terraform apply, in your CI if you need periodic IP refreshes without a source change.
6. Repeated Worker deploys may create new Cloudflare Worker versions, but preserve the Worker identity, Durable Object namespace and already-applied migration history. This is desired-state idempotency, not a promise of zero API writes.

If an unmanaged old Access application protects a **different** path, provide its explicit ID to adopt and move it rather than creating an additional application. Domain/path discovery alone deliberately does not guess which old application to repurpose. More-specific old applications can override expected policy behavior; review them before rollout.

Terraform-managed lists/policies/applications use `prevent_destroy` to prevent accidental deletion or replacement. To intentionally retire them, first review dependencies and explicitly change that protection. This project intentionally has no one-command Worker/Durable Object destroy operation.

### Migrating from the earlier Rules-list mirrors

Earlier versions tried to maintain two Rules custom lists in addition to the two Zero Trust lists. Cloudflare's Free plan allows only [one Rules custom list](https://developers.cloudflare.com/waf/tools/lists/#availability), so a partial apply could create the Zero Trust resources and one Rules list, then fail with error `10019` while trying to create the second Rules list.

[main.tf](./main.tf) now contains a Terraform `removed` block for the legacy `cloudflare_list.relay` instances with `destroy = false`. On the next apply, Terraform **forgets those instances without deleting or updating the actual Rules lists**. No `terraform state rm`, resource deletion or fresh state is needed. Keep the partial apply's existing state so Terraform retains the six successfully created Access resources.

Run `npm run plan` first. The Rules list should be reported as **no longer managed, but not destroyed**; no replacement Rules list should be proposed. Then rerun `npm run deploy` to apply the state-only removal and any reviewed Access changes, and continue the Worker upload that the earlier failed apply prevented.

After removal, the legacy Rules list remains in Cloudflare unchanged and is outside this deployment's ownership. Its IP contents will no longer be refreshed or verified here. Any rules using that list are also unchanged. Only Zero Trust list contents continue to synchronize from GitHub/Gitea inputs. The old `existing_resources.rules_lists` Terraform input and `rules_list_id` endpoint output have been removed; use `existing_resources.access_lists` and `access_list_id` for the managed Zero Trust lists.

### Persist state, including in CI

The default backend is local. Keep `terraform.tfstate` and its backup secure and persistent, and use the same state for repeat deployments. Never commit state, dotenv files, secrets or generated plans/configuration. Losing state loses ownership tracking even though name discovery can assist recovery.

For team/CI use, configure a supported remote backend in a local, ignored `backend_override.tf`, then run `terraform init -migrate-state`. Supply backend credentials through its standard environment mechanism, not source files. The wrapper's `init` reuses that backend. Terraform's standard `TF_CLI_ARGS_init` can supply a backend config path when needed.

The wrapper holds `.generated/deploy.lock` for its entire run; Terraform also takes its backend lock while applying. CI must serialize the **entire pipeline** per account/Worker, because different machines do not share the local lock and the Worker upload follows Terraform's lock release. If a process crashes, inspect the PID stored in the lock and confirm it is stopped before removing that specific file.

### Secret handling

Secrets are never placed in Terraform configuration, tfvars, state or outputs. For deployment, the wrapper creates an ignored `.generated/secrets.json` with restrictive file mode where supported and passes its path to Wrangler's `deploy --secrets-file`. Wrangler uploads code and both secrets in the same version, avoiding a first deployment without its required secrets. The wrapper removes the file in `finally`, including on deployment/verification failure. On Windows, restrict the workspace directory's inherited ACLs as well; POSIX modes alone do not enforce Windows ACLs. A forcibly killed process can leave the file behind: remove it securely after the process stops, or rerun after clearing the stale lock to trigger cleanup.

Use separate high-entropy secrets, do not enable verbose credential logging, and do not publish generated directories or CI environment dumps. Existing additional remote Worker secrets are preserved by Wrangler.

## Direct Terraform use

The environment wrapper is the recommended end-to-end entrypoint. For infrastructure-only operations:

```powershell
Copy-Item terraform.tfvars.example terraform.tfvars
# Set CLOUDFLARE_API_TOKEN in your environment and edit terraform.tfvars.
terraform init
terraform plan
terraform apply
```

All Terraform inputs are documented in [variables.tf](./variables.tf). Supply `existing_resources` IDs to adopt resources when bypassing wrapper discovery. Do not mix independently configured `terraform.tfvars` with wrapper-generated inputs. Direct Terraform does **not** build/upload the Worker or manage Worker secrets/runtime path bindings/routing; it manages the six Zero Trust/Access resources only. When bypassing the wrapper, explicitly keep the Worker's Wrangler path variables identical to Terraform's endpoint paths.

## Validation and rollout

```powershell
npm test
npm run test:worker
terraform fmt -check -recursive
terraform validate
terraform test
npm run dry-run
```

The Node tests cover configuration, route consistency, migration preservation, both endpoint modes, adoption, pagination, fail-closed errors and remote verification. `test:worker` builds the real Rust/Wasm Worker and uses the pinned Wrangler's local runtime to check custom webhook/WebSocket paths through the Durable Object, signed ping acceptance, old-path rejection and missing/invalid binding failures. Terraform tests use mocked providers; they assert exact membership/linking, custom paths and invalid GitHub/Gitea/path data rejection without touching Cloudflare. Dry-run compiles the actual Rust Worker and packages the generated deployment configuration, but does not prove remote account entitlements.

After deployment, the wrapper automatically verifies Cloudflare's resource metadata. Then perform end-to-end checks from the actual allowed networks:

- Send a signed GitHub ping/push to Terraform's `webhook_url`; verify 200 and delivery to the authenticated Gitea connection.
- Connect from the Gitea server to `websocket_url` with its bearer secret; verify the WebSocket upgrade and push delivery.
- Verify requests from nonallowed source addresses are denied by Access, and allowed-IP requests with invalid Worker credentials are rejected by the Worker.
- Verify preview URLs, and workers.dev in custom-domain mode, are unavailable.

Metadata verification proves configured resource links, not actual data-plane propagation, signature validation, secret value equality, or WebSocket delivery. Secret values cannot be read back from Cloudflare.

## References

- [Shared design conversation](https://chatgpt.com/share/6ad29643-9a5c-83e9-8980-e6e050e20507)
- [Cloudflare Zero Trust lists versus account custom lists](https://developers.cloudflare.com/cloudflare-one/reusable-components/lists/)
- [Access Service Auth and policy behavior](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Wrangler deploy and secrets-file](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [Wrangler runtime environment variable bindings](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [Durable Object migration history](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)
- [workers.dev routing and exposure](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
