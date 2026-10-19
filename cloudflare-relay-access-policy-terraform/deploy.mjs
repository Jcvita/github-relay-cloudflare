/**
 * Coordinates Terraform-owned security resources with the existing Rust Worker's
 * Wrangler-owned code, secrets, routing and Durable Object migration history.
 *
 * All commands merge dotenv settings with environment overrides, validate the
 * target and relay paths, and acquire a local lock before generating config.
 * Path settings become both Terraform Access destinations and Wrangler text
 * bindings, which the Rust Worker and Durable Object read from their runtime Env.
 * - dry-run: build/package the Worker without contacting Cloudflare's account API.
 * - plan: discover resources for adoption and preview Terraform reconciliation.
 * - deploy: build first, apply security resources, upload code and secrets
 *   together, then verify the remote resource links against Terraform outputs.
 * - verify: check the deployed configuration without applying or uploading.
 *
 * Terraform fetches GitHub's current webhook CIDRs from /meta; this wrapper keeps
 * credentials out of Terraform inputs and removes its temporary secret file on
 * normal completion or failure. Deployment is resumable, not transactional:
 * an upload failure does not roll back an already successful Terraform apply.
 */
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, open, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { parse as parseToml } from "smol-toml";

export const projectDir = dirname(fileURLToPath(import.meta.url));
const generatedDir = join(projectDir, ".generated");
const secretNames = ["GITHUB_WEBHOOK_SECRET", "GITHUB_RELAY_WEBSOCKET_SECRET"];
// Access references Zero Trust lists; Rules-list mirrors are no longer managed.
const groups = {
  access_lists: { route: "gateway/lists", resource: "cloudflare_zero_trust_list" },
  policies: { route: "access/policies", resource: "cloudflare_zero_trust_access_policy" },
  applications: { route: "access/apps", resource: "cloudflare_zero_trust_access_application" },
};

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

// Normalize host suffixes and IPv6 spelling for comparisons with API responses.
export function canonicalIP(value) {
  const [address, prefix, ...extra] = value.split("/");
  const family = isIP(address);
  const max = family === 4 ? 32 : 128;
  if (!family || extra.length || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > max))) {
    throw new Error(`Invalid IP address or CIDR: ${value}`);
  }
  const normalized = family === 6 ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address;
  return `${normalized}/${prefix === undefined ? max : Number(prefix)}`;
}

export function configuration(env, source, workerDir) {
  const account = required(env, "CLOUDFLARE_ACCOUNT_ID");
  const hostname = required(env, "CLOUDFLARE_ACCESS_APPLICATION_DOMAIN").toLowerCase();
  const mode = env.RELAY_ENDPOINT_MODE || (hostname.endsWith(".workers.dev") ? "workers_dev" : "custom_domain");
  const workerName = env.CLOUDFLARE_WORKER_NAME || source.name;
  const zone = env.CLOUDFLARE_ZONE_ID || null;
  if (!/^[a-fA-F0-9]{32}$/.test(account)) throw new Error("Invalid CLOUDFLARE_ACCOUNT_ID.");
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) throw new Error("Invalid CLOUDFLARE_WORKER_NAME.");
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
    throw new Error("CLOUDFLARE_ACCESS_APPLICATION_DOMAIN must be a DNS hostname without a scheme, port or path.");
  }
  if (!["custom_domain", "workers_dev"].includes(mode)) throw new Error("RELAY_ENDPOINT_MODE must be custom_domain or workers_dev.");
  if (mode === "custom_domain" && !/^[a-fA-F0-9]{32}$/.test(zone || "")) throw new Error("Custom domains require CLOUDFLARE_ZONE_ID.");
  if ((mode === "workers_dev") !== hostname.endsWith(".workers.dev")) throw new Error("Endpoint mode does not match the configured hostname.");
  if (!source.main || !source.compatibility_date || !source.build?.command) throw new Error("The source Wrangler config must declare main, compatibility_date and build.command.");
  // Reuse the existing namespace contract and migrations instead of inventing a new identity.
  const binding = source.durable_objects?.bindings?.find(item => item.name === "GITHUB_HOOK_RELAY");
  if (binding?.class_name !== "GithubHookRelay" || binding.script_name) throw new Error("Expected a local GITHUB_HOOK_RELAY binding to GithubHookRelay.");
  if (!source.migrations?.some(migration => migration.new_sqlite_classes?.includes("GithubHookRelay"))) {
    throw new Error("The source migration history must create the SQLite GithubHookRelay class.");
  }
  const ips = required(env, "GITEA_SERVER_PUBLIC_IPS").split(",").map(ip => ip.trim());
  ips.forEach(canonicalIP);
  const endpoints = {};
  const existing = Object.fromEntries(Object.keys(groups).map(key => [key, {}]));
  // One value drives both Access destinations and the Worker's runtime route bindings.
  for (const key of ["github", "gitea"]) {
    const upper = key.toUpperCase();
    const variable = `CLOUDFLARE_${upper}_ACCESS_APPLICATION_PATH`;
    const path = env[variable] ?? source.vars?.[variable];
    if (typeof path !== "string" || !/^\/[A-Za-z0-9._~/-]+$/.test(path) ||
        path.slice(1).split("/").some(segment => !segment || segment === "." || segment === "..")) {
      throw new Error(`${variable} must be a canonical non-root path with nonempty ASCII URL-unreserved segments, without trailing slash, query, fragment or encoding.`);
    }
    const listName = env[`CLOUDFLARE_${upper}_IP_LIST_NAME`] || (key === "github" ? "github_hooks_ips" : "gitea_server_ips");
    if (!/^[a-z0-9_]+$/.test(listName)) throw new Error(`Invalid ${upper} IP list name; use lowercase letters, digits or underscores.`);
    endpoints[key] = {
      list_name: listName,
      list_description: env[`CLOUDFLARE_${upper}_IP_LIST_DESCRIPTION`] || `List of ${key === "github" ? "GitHub" : "Gitea"} IPs`,
      policy_name: env[`CLOUDFLARE_${upper}_AC_POLICY_NAME`] || (key === "github" ? "GitHub Git Hook IP Policy" : "Gitea WebSocket IP Policy"),
      application_name: env[`CLOUDFLARE_${upper}_ACCESS_APPLICATION_NAME`] || (key === "github" ? "GitHub Git Hook" : "Gitea WebSocket"),
      path,
    };
    for (const [group, suffix] of Object.entries({
      access_lists: "ZERO_TRUST_IP_LIST_ID",
      policies: "AC_POLICY_ID", applications: "ACCESS_APPLICATION_ID",
    })) {
      const id = env[`CLOUDFLARE_${upper}_${suffix}`]?.trim();
      if (id) existing[group][key] = id;
    }
  }
  if (endpoints.github.list_name === endpoints.gitea.list_name || endpoints.github.policy_name === endpoints.gitea.policy_name) {
    throw new Error("GitHub and Gitea must have distinct list and policy names.");
  }
  if (endpoints.github.path === endpoints.gitea.path ||
      endpoints.github.path.startsWith(`${endpoints.gitea.path}/`) ||
      endpoints.gitea.path.startsWith(`${endpoints.github.path}/`)) {
    throw new Error("GitHub and Gitea paths must be distinct and non-nested to avoid overlapping Access applications.");
  }
  // Neither generated configuration contains secret values; Wrangler gets them separately.
  const terraform = {
    cloudflare_account_id: account, hostname, worker_name: workerName, endpoint_mode: mode,
    cloudflare_zone_id: zone, gitea_server_public_ips: [...new Set(ips)], endpoints, existing_resources: existing,
  };
  // Preserve source build/runtime settings while making public routing explicit.
  const wrangler = {
    ...source,
    name: workerName,
    account_id: account,
    main: resolve(workerDir, source.main),
    build: { ...source.build, cwd: workerDir },
    vars: {
      ...source.vars,
      CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH: endpoints.github.path,
      CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH: endpoints.gitea.path,
    },
    workers_dev: mode === "workers_dev",
    preview_urls: false,
    routes: mode === "custom_domain" ? [{ pattern: hostname, custom_domain: true, zone_id: zone }] : [],
    observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true } },
    secrets: { required: secretNames },
  };
  delete wrangler.env;
  return { terraform, wrangler };
}

export function createApi(token, fetcher = fetch) {
  return async function api(path) {
    // Retry rate limits and server errors only; authorization/configuration errors fail immediately.
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetcher(`https://api.cloudflare.com/client/v4/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await new Promise(done => setTimeout(done, 1000 * 2 ** attempt));
        continue;
      }
      const body = await response.json();
      if (!response.ok || body.success !== true) {
        throw new Error(`Cloudflare GET ${path.split("?")[0]} failed (${response.status}): ${JSON.stringify(body.errors)}`);
      }
      return body;
    }
  };
}

// Cloudflare endpoints mix single-page, page-number and cursor response formats.
// Abort on stalled pagination rather than silently adopting/verifying a partial inventory.
export async function listAll(api, route) {
  const result = [];
  let cursor;
  for (let page = 1; page <= 1000; page++) {
    const query = new URLSearchParams({ page: String(page), per_page: "100" });
    if (cursor) query.set("cursor", cursor);
    const body = await api(`${route}?${query}`);
    if (!Array.isArray(body.result)) throw new Error(`Cloudflare ${route} did not return an array.`);
    result.push(...body.result);
    const info = body.result_info;
    if (!info) return result;
    const next = info?.cursors?.after;
    if (next) {
      if (next === cursor) throw new Error(`Cloudflare ${route} repeated a pagination cursor.`);
      cursor = next;
    } else if (info?.cursors) {
      return result;
    } else if (info?.total_pages != null) {
      if (page >= info.total_pages) return result;
    } else if (info?.total_count != null) {
      if (result.length >= info.total_count) return result;
    } else if (body.result.length < 100) {
      return result;
    }
    if (!body.result.length) throw new Error(`Cloudflare ${route} returned an empty page before pagination completed.`);
  }
  throw new Error(`Cloudflare ${route} exceeded the pagination limit.`);
}

export async function discover(api, tf, managed = new Map()) {
  const accountRoute = `accounts/${tf.cloudflare_account_id}`;
  const results = await Promise.all(Object.entries(groups).map(async ([group, spec]) => {
    const resources = await listAll(api, `${accountRoute}/${spec.route}`);
    const ids = {};
    for (const [key, endpoint] of Object.entries(tf.endpoints)) {
      const explicitId = tf.existing_resources[group][key];
      const address = `${spec.resource}.relay["${key}"]`;
      const stateId = managed.get(address);
      // Existing state pins ownership; an explicit override must agree with it.
      // Only resources without either ID are discovered by exact name or domain/path.
      // Known application IDs may move paths on this hostname without creating duplicates.
      if (explicitId && stateId && explicitId !== stateId) throw new Error(`${address} is already managed with a different ID.`);
      const targetId = explicitId || stateId;
      const matches = resources.filter(item => targetId ? item.id === targetId :
        group === "applications" ? item.domain === `${tf.hostname}${endpoint.path}` :
          item.name === (group === "policies" ? endpoint.policy_name : endpoint.list_name));
      if (matches.length > 1) throw new Error(`Ambiguous ${group} for ${key}; supply an explicit ID.`);
      if (!matches.length) {
        if (explicitId) throw new Error(`Configured ${group} ID for ${key} was not found in this account.`);
        continue;
      }
      const item = matches[0];
      if (group === "access_lists" && item.type !== "IP") throw new Error(`${key} Zero Trust list is not an IP list.`);
      if (group === "applications" && (item.type !== "self_hosted" ||
          item.domain?.split("/")[0] !== tf.hostname)) {
        throw new Error(`${key} Access application must be self_hosted on the configured hostname ${tf.hostname}.`);
      }
      ids[key] = item.id;
    }
    return [group, ids];
  }));
  return Object.fromEntries(results);
}

// Index Terraform addresses across root/child modules; an empty state has no values.
export function managedResources(state) {
  const resources = new Map();
  function walk(module) {
    for (const item of module?.resources || []) resources.set(item.address, item.values.id);
    for (const child of module?.child_modules || []) walk(child);
  }
  walk(state.values?.root_module);
  return resources;
}

export function run(command, args, { capture = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: projectDir, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} failed with exit code ${result.status}.`);
  }
  return result.stdout;
}

function sameIPs(actual, expected) {
  return JSON.stringify([...new Set(actual.map(canonicalIP))].sort()) ===
    JSON.stringify([...new Set(expected.map(canonicalIP))].sort());
}

export async function verify(api, deployment, source) {
  const accountRoute = `accounts/${deployment.account_id}`;
  // Check exact memberships and links, not merely that the expected resources exist.
  for (const [key, endpoint] of Object.entries(deployment.endpoints)) {
    const [accessItems, policy, app] = await Promise.all([
      listAll(api, `${accountRoute}/gateway/lists/${endpoint.access_list_id}/items`),
      api(`${accountRoute}/access/policies/${endpoint.policy_id}`).then(body => body.result),
      api(`${accountRoute}/access/apps/${endpoint.application_id}`).then(body => body.result),
    ]);
    if (!sameIPs(accessItems.map(item => item.value), deployment.source_ips[key])) {
      throw new Error(`${key} Zero Trust IP list does not match the Terraform deployment.`);
    }
    if (policy.decision !== "non_identity" || policy.include?.length !== 1 ||
        policy.include[0].ip_list?.id !== endpoint.access_list_id ||
        policy.exclude?.length || policy.require?.length) {
      throw new Error(`${key} Access policy does not restrict access solely to its intended IP list.`);
    }
    if (app.type !== "self_hosted" || app.domain !== `${deployment.hostname}${endpoint.path}` ||
        app.destinations?.length !== 1 || app.destinations[0].type !== "public" ||
        app.destinations[0].uri !== `${deployment.hostname}${endpoint.path}` ||
        app.policies?.length !== 1 || app.policies[0].id !== endpoint.policy_id) {
      throw new Error(`${key} Access application has an incorrect path or policy link.`);
    }
  }
  // Validate the namespace/storage backend and applied migration independently of Access.
  const script = `${accountRoute}/workers/scripts/${encodeURIComponent(deployment.worker_name)}`;
  const [settings, subdomain, namespaces, service] = await Promise.all([
    api(`${script}/settings`).then(body => body.result),
    api(`${script}/subdomain`).then(body => body.result),
    listAll(api, `${accountRoute}/workers/durable_objects/namespaces`),
    api(`${accountRoute}/workers/services/${encodeURIComponent(deployment.worker_name)}`).then(body => body.result),
  ]);
  const binding = settings.bindings?.find(item => item.name === "GITHUB_HOOK_RELAY");
  for (const [key, endpoint] of Object.entries(deployment.endpoints)) {
    const name = `CLOUDFLARE_${key.toUpperCase()}_ACCESS_APPLICATION_PATH`;
    const route = settings.bindings?.find(item => item.name === name);
    if (route?.type !== "plain_text" || route.text !== endpoint.path) {
      throw new Error(`Deployed Worker path binding ${name} does not match its Access application.`);
    }
  }
  if (binding?.type !== "durable_object_namespace" || binding.class_name !== "GithubHookRelay" ||
      !namespaces.some(item => item.id === binding.namespace_id && item.class === "GithubHookRelay" &&
        item.script === deployment.worker_name && item.use_sqlite === true)) {
    throw new Error("The deployed Worker is not linked to its GithubHookRelay namespace.");
  }
  // The applied migration tag comes from service metadata, not the bindings/settings response.
  const lastMigration = source.migrations.at(-1).tag;
  if (service.default_environment?.script?.migration_tag !== lastMigration) throw new Error(`Expected deployed Durable Object migration tag ${lastMigration}.`);
  if (settings.compatibility_date !== source.compatibility_date ||
      settings.observability?.enabled !== true || settings.observability?.traces?.enabled !== true) {
    throw new Error("Worker compatibility date or observability does not match the deployment configuration.");
  }
  // Cloudflare exposes secret names/types, not values; this cannot prove secret equality.
  for (const name of secretNames) {
    if (!settings.bindings.some(item => item.name === name && item.type === "secret_text")) throw new Error(`Deployed Worker is missing secret ${name}.`);
  }
  // Alternate public URLs must not bypass the path-specific Access applications.
  if (subdomain.enabled !== (deployment.endpoint_mode === "workers_dev") || subdomain.previews_enabled !== false) {
    throw new Error("Worker workers.dev or preview URL exposure does not match the configured endpoint mode.");
  }
  if (deployment.endpoint_mode === "custom_domain") {
    const domains = await listAll(api, `${accountRoute}/workers/domains`);
    if (!domains.some(domain => domain.hostname === deployment.hostname &&
      domain.service === deployment.worker_name && domain.zone_id === deployment.zone_id)) {
      throw new Error("Custom domain is not routed to the configured Worker and zone.");
    }
  }
}

// Confirm hostname ownership before Terraform changes or a Worker upload can occur.
async function checkEndpoint(api, tf) {
  if (tf.endpoint_mode === "workers_dev") {
    const { result } = await api(`accounts/${tf.cloudflare_account_id}/workers/subdomain`);
    if (tf.hostname !== `${tf.worker_name}.${result.subdomain}.workers.dev`) {
      throw new Error("Configured workers.dev hostname does not match the Worker name and account subdomain.");
    }
  } else {
    const { result } = await api(`zones/${tf.cloudflare_zone_id}`);
    if (result.account?.id !== tf.cloudflare_account_id ||
        !(tf.hostname === result.name || tf.hostname.endsWith(`.${result.name}`))) {
      throw new Error("Custom hostname must belong to the configured zone and account.");
    }
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const { positionals, values } = parseArgs({
    args, allowPositionals: true,
    options: { "env-file": { type: "string" }, yes: { type: "boolean", default: false } },
  });
  const [command] = positionals;
  if (positionals.length !== 1 || !["plan", "deploy", "dry-run", "verify"].includes(command)) {
    throw new Error("Usage: node deploy.mjs <plan|deploy|dry-run|verify> [--env-file path] [--yes]");
  }
  // A default .env is optional; an explicitly requested missing file is an error.
  const envPath = resolve(projectDir, values["env-file"] || ".env");
  let fileEnv = {};
  try {
    fileEnv = parseEnv(await readFile(envPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" || values["env-file"]) throw error;
  }
  // Shell/CI values take precedence; the source project remains read-only.
  env = { ...fileEnv, ...env };
  const workerDir = env.WORKER_PROJECT_DIR ? resolve(projectDir, env.WORKER_PROJECT_DIR) : resolve(projectDir, "..", "githook-relay-worker");
  const source = parseToml(await readFile(join(workerDir, "wrangler.toml"), "utf8"));
  const config = configuration(env, source, workerDir);
  const secrets = {};
  // Fail before building or changing infrastructure if required upload secrets are missing.
  if (command === "deploy") {
    for (const name of secretNames) {
      if (!env[name]?.trim()) throw new Error(`${name} is required for deployment.`);
      secrets[name] = env[name];
    }
    if (secrets[secretNames[0]] === secrets[secretNames[1]]) throw new Error("Webhook and WebSocket secrets must be different.");
  }
  // Hold this local lock through apply, upload and verification. Cross-machine CI
  // still needs pipeline-level serialization beyond Terraform's apply-time lock.
  await mkdir(generatedDir, { recursive: true, mode: 0o700 });
  const lockPath = join(generatedDir, "deploy.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Another wrapper invocation holds .generated/deploy.lock. Remove it only after confirming that process has stopped.");
    throw error;
  }
  const secretsPath = join(generatedDir, "secrets.json");
  try {
    await lock.writeFile(String(process.pid));
    // After acquiring ownership, remove any secret file left by an interrupted run.
    await rm(secretsPath, { force: true });
    const wranglerPath = join(generatedDir, "wrangler.json");
    const tfvarsPath = join(generatedDir, "deployment.tfvars.json");
    await writeFile(wranglerPath, JSON.stringify(config.wrangler, null, 2));
    const childEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: config.terraform.cloudflare_account_id, WRANGLER_SEND_METRICS: "false" };
    const terraform = env.TERRAFORM_BIN || "terraform";
    const tf = (args, capture = false) => run(terraform, args, { capture, env: childEnv });
    const wrangler = (...args) => run(process.execPath, [
      join(projectDir, "node_modules", "wrangler", "bin", "wrangler.js"), ...args,
    ], { env: childEnv });
    // Catch Rust/build/packaging errors before applying any remote security changes.
    if (command === "dry-run" || command === "deploy") {
      wrangler("deploy", "--config", wranglerPath, "--dry-run", "--outdir", join(generatedDir, "bundle"));
      if (command === "dry-run") return;
    }
    const api = createApi(required(env, "CLOUDFLARE_API_TOKEN"));
    await checkEndpoint(api, config.terraform);
    tf(["init", "-input=false"]);
    if (command !== "verify") {
      // Discovery supplies declarative import IDs; planning itself does not adopt resources.
      const state = JSON.parse(tf(["show", "-json"], true));
      config.terraform.existing_resources = await discover(api, config.terraform, managedResources(state));
      await writeFile(tfvarsPath, JSON.stringify(config.terraform, null, 2));
      tf(["validate"]);
      if (command === "plan") {
        tf(["plan", "-input=false", `-var-file=${tfvarsPath}`]);
        return;
      }
      // Establish IP lists and Access restrictions before publishing the public endpoint.
      tf(["apply", `-var-file=${tfvarsPath}`, ...(values.yes ? ["-auto-approve", "-input=false"] : [])]);
      // Pass secrets by temporary file path, never CLI values or Terraform variables.
      // POSIX modes are restrictive where supported; Windows also needs suitable directory ACLs.
      await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
      // The dry run already built the Rust package; upload exactly that build.
      const uploadConfig = { ...config.wrangler };
      delete uploadConfig.build;
      await writeFile(wranglerPath, JSON.stringify(uploadConfig, null, 2));
      wrangler("deploy", "--config", wranglerPath, "--secrets-file", secretsPath);
    }
    // Verify against persisted Terraform outputs, rejecting state for another target.
    // These metadata checks do not replace signed-webhook/WebSocket end-to-end tests.
    const deployment = JSON.parse(tf(["output", "-json", "deployment"], true));
    if (deployment.account_id !== config.terraform.cloudflare_account_id || deployment.worker_name !== config.terraform.worker_name ||
        deployment.hostname !== config.terraform.hostname || deployment.endpoint_mode !== config.terraform.endpoint_mode ||
        Object.entries(config.terraform.endpoints).some(([key, endpoint]) => deployment.endpoints[key]?.path !== endpoint.path)) {
      throw new Error("Terraform state does not match this deployment configuration.");
    }
    await verify(api, deployment, source);
    console.log(`Verified Terraform resources, Worker, secrets and Durable Object migration links.\nWebhook: ${deployment.webhook_url}\nWebSocket: ${deployment.websocket_url}`);
  } finally {
    // Runs on success, early returns and exceptions; a forcibly killed process may leave files.
    await rm(secretsPath, { force: true });
    await lock.close();
    await rm(lockPath);
  }
}

// Imports expose helpers to tests without executing a deployment.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
