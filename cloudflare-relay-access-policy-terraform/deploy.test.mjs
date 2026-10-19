import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { canonicalIP, configuration, createApi, discover, listAll, main, managedResources, projectDir, verify } from "./deploy.mjs";

const workerDir = resolve(projectDir, "..", "githook-relay-worker");
const source = parseToml(await readFile(resolve(workerDir, "wrangler.toml"), "utf8"));
const baseEnv = {
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CLOUDFLARE_ZONE_ID: "abcdef0123456789abcdef0123456789",
  CLOUDFLARE_ACCESS_APPLICATION_DOMAIN: "relay.example.com",
  GITEA_SERVER_PUBLIC_IPS: "203.0.113.10,2001:db8::/48",
};
const config = (env = {}, workerSource = source) => configuration({ ...baseEnv, ...env }, workerSource, workerDir);
const clone = value => structuredClone(value);

test("custom domain config preserves all Rust migrations and bindings without copying secrets", () => {
  const { terraform, wrangler } = config({
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    GITHUB_RELAY_WEBSOCKET_SECRET: "test-websocket-secret",
    CLOUDFLARE_API_TOKEN: "test-api-token",
  });
  assert.deepEqual(wrangler.migrations, source.migrations);
  assert.deepEqual(wrangler.durable_objects, source.durable_objects);
  assert.equal(wrangler.compatibility_date, source.compatibility_date);
  assert.equal(wrangler.main, resolve(workerDir, source.main));
  assert.equal(wrangler.build.cwd, workerDir);
  assert.equal(wrangler.workers_dev, false);
  assert.equal(wrangler.preview_urls, false);
  assert.deepEqual(wrangler.routes, [{ pattern: "relay.example.com", custom_domain: true, zone_id: baseEnv.CLOUDFLARE_ZONE_ID }]);
  assert.equal(terraform.endpoints.github.path, "/relay/webhooks/github/push");
  assert.equal(wrangler.vars.CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH, terraform.endpoints.github.path);
  assert.equal(wrangler.vars.CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH, terraform.endpoints.gitea.path);
  assert.equal(wrangler.observability.traces.enabled, true);
  assert.equal(wrangler.observability.logs.enabled, true);
  for (const secret of ["test-webhook-secret", "test-websocket-secret", "test-api-token"]) {
    assert.ok(!JSON.stringify({ terraform, wrangler }).includes(secret));
  }
});

test("custom paths drive both Terraform destinations and Wrangler runtime bindings", () => {
  const workerSource = clone(source);
  workerSource.vars.UNRELATED_SETTING = "preserved";
  const { terraform, wrangler } = config({
    CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH: "/custom/github-hook",
    CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH: "/custom/socket",
  }, workerSource);
  assert.equal(terraform.endpoints.github.path, "/custom/github-hook");
  assert.equal(terraform.endpoints.gitea.path, "/custom/socket");
  assert.equal(wrangler.vars.CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH, terraform.endpoints.github.path);
  assert.equal(wrangler.vars.CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH, terraform.endpoints.gitea.path);
  assert.equal(wrangler.vars.UNRELATED_SETTING, "preserved");
  assert.equal(source.vars.CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH, "/relay/webhooks/github/push");
});

test("missing path defaults require explicit settings instead of a silent fallback", () => {
  const workerSource = clone(source);
  delete workerSource.vars.CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH;
  assert.throws(() => config({}, workerSource), /CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH must be/);
  assert.equal(config({ CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH: "/new/hook" }, workerSource).terraform.endpoints.github.path, "/new/hook");
});

test("ambiguous or overlapping path configurations fail before deployment", () => {
  for (const path of ["", "/", "relative", "//hook", "/hook/", "/hook//push", "/a/./b",
    "/a/../b", "/hook?x=1", "/hook#fragment", "/hook*", "/a%2fb", "/a\\b", "/has space", "/caf\u00e9"]) {
    for (const key of ["GITHUB", "GITEA"]) {
      assert.throws(() => config({ [`CLOUDFLARE_${key}_ACCESS_APPLICATION_PATH`]: path }), /canonical non-root path/);
    }
  }
  for (const [github, gitea] of [["/same", "/same"], ["/relay", "/relay/ws"], ["/relay/hook", "/relay"]]) {
    assert.throws(() => config({
      CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH: github,
      CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH: gitea,
    }), /distinct and non-nested/);
  }
  assert.doesNotThrow(() => config({
    CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH: "/hooks/github.push_v2-~",
    CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH: "/hooks/socket",
  }));
});

test("workers.dev can be selected explicitly or inferred without a zone", () => {
  for (const mode of ["workers_dev", undefined]) {
    const { terraform, wrangler } = config({
      CLOUDFLARE_ZONE_ID: "",
      CLOUDFLARE_ACCESS_APPLICATION_DOMAIN: "githook-relay-worker.example.workers.dev",
      RELAY_ENDPOINT_MODE: mode,
    });
    assert.equal(terraform.endpoint_mode, "workers_dev");
    assert.equal(wrangler.workers_dev, true);
    assert.equal(wrangler.preview_urls, false);
    assert.deepEqual(wrangler.routes, []);
  }
});

test("source variables and Access resource identifiers are configurable", () => {
  const { terraform, wrangler } = config({
    CLOUDFLARE_WORKER_NAME: "another-relay",
    CLOUDFLARE_GITHUB_IP_LIST_ID: "rules-id",
    CLOUDFLARE_GITHUB_ZERO_TRUST_IP_LIST_ID: "access-id",
    CLOUDFLARE_GITHUB_IP_LIST_NAME: "existing_github_hooks",
    CLOUDFLARE_GITHUB_AC_POLICY_ID: "policy-id",
    CLOUDFLARE_GITHUB_AC_POLICY_NAME: "Existing GitHub Policy",
    CLOUDFLARE_GITHUB_ACCESS_APPLICATION_ID: "app-id",
    CLOUDFLARE_GITHUB_ACCESS_APPLICATION_NAME: "Existing GitHub App",
  });
  assert.equal(wrangler.name, "another-relay");
  assert.equal(Object.hasOwn(terraform.existing_resources, "rules_lists"), false);
  assert.equal(terraform.existing_resources.access_lists.github, "access-id");
  assert.equal(terraform.existing_resources.policies.github, "policy-id");
  assert.equal(terraform.existing_resources.applications.github, "app-id");
  assert.equal(terraform.endpoints.github.list_name, "existing_github_hooks");
  assert.equal(terraform.endpoints.github.policy_name, "Existing GitHub Policy");
  assert.equal(terraform.endpoints.github.application_name, "Existing GitHub App");
});

test("invalid configuration fails before deployment", () => {
  for (const [env, pattern] of [
    [{ GITEA_SERVER_PUBLIC_IPS: "" }, /required/],
    [{ GITEA_SERVER_PUBLIC_IPS: "203.0.113.10," }, /Invalid IP/],
    [{ GITEA_SERVER_PUBLIC_IPS: "2001:db8::/129" }, /Invalid IP/],
    [{ GITEA_SERVER_PUBLIC_IPS: "192.0.2.1/33" }, /Invalid IP/],
    [{ CLOUDFLARE_ACCESS_APPLICATION_DOMAIN: "https://relay.example.com/relay" }, /DNS hostname/],
    [{ CLOUDFLARE_ACCESS_APPLICATION_DOMAIN: "bad..example.com" }, /DNS hostname/],
    [{ RELAY_ENDPOINT_MODE: "invalid" }, /RELAY_ENDPOINT_MODE/],
    [{ RELAY_ENDPOINT_MODE: "workers_dev" }, /does not match/],
    [{ CLOUDFLARE_ZONE_ID: "" }, /CLOUDFLARE_ZONE_ID/],
    [{ CLOUDFLARE_GITHUB_IP_LIST_NAME: "GitHub Hooks IP List" }, /Invalid GITHUB IP list name/],
    [{ CLOUDFLARE_ACCOUNT_ID: "" }, /required/],
    [{ CLOUDFLARE_WORKER_NAME: "-invalid" }, /CLOUDFLARE_WORKER_NAME/],
    [{ CLOUDFLARE_GITHUB_IP_LIST_NAME: "same", CLOUDFLARE_GITEA_IP_LIST_NAME: "same" }, /distinct/],
  ]) {
    assert.throws(() => config(env), pattern);
  }
});

test("missing or external Durable Object binding and missing SQLite migration fail", () => {
  const external = clone(source);
  external.durable_objects.bindings[0].script_name = "different-worker";
  assert.throws(() => config({}, external), /local GITHUB_HOOK_RELAY/);
  const wrongClass = clone(source);
  wrongClass.durable_objects.bindings[0].class_name = "OtherClass";
  assert.throws(() => config({}, wrongClass), /local GITHUB_HOOK_RELAY/);
  assert.throws(() => config({}, { ...source, migrations: [] }), /migration history/);
  assert.throws(() => config({}, { ...source, build: undefined }), /build.command/);
});

test("IP comparisons normalize IPv4 host suffixes and IPv6 compression", () => {
  assert.equal(canonicalIP("203.0.113.10"), canonicalIP("203.0.113.10/32"));
  assert.equal(canonicalIP("2001:0db8:0000:0000::1"), canonicalIP("2001:db8::1/128"));
  for (const ip of ["", "not-an-ip", "192.0.2.1/", "192.0.2.1/24/32", "192.0.2.1/-1"]) {
    assert.throws(() => canonicalIP(ip), /Invalid IP/);
  }
});

test("deploy rejects missing or reused secrets before building or contacting Cloudflare", async () => {
  const args = ["deploy", "--env-file", resolve(projectDir, ".env.example")];
  await assert.rejects(main(args, { ...baseEnv, GITHUB_WEBHOOK_SECRET: "", GITHUB_RELAY_WEBSOCKET_SECRET: "" }), /GITHUB_WEBHOOK_SECRET is required/);
  await assert.rejects(main(args, { ...baseEnv, GITHUB_WEBHOOK_SECRET: "test-secret", GITHUB_RELAY_WEBSOCKET_SECRET: "" }), /GITHUB_RELAY_WEBSOCKET_SECRET is required/);
  await assert.rejects(main(args, { ...baseEnv, GITHUB_WEBHOOK_SECRET: "same", GITHUB_RELAY_WEBSOCKET_SECRET: "same" }), /must be different/);
});

test("CLI rejects invalid commands and explicitly missing dotenv files", async () => {
  await assert.rejects(main(["destroy"], baseEnv), /Usage:/);
  await assert.rejects(main(["deploy", "extra"], baseEnv), /Usage:/);
  await assert.rejects(main(["plan", "--env-file", "nonexistent-test.env"], baseEnv), /ENOENT/);
});

test("API errors are explicit and requests have authorization and timeouts", async () => {
  const api = createApi("test-token", async (url, options) => {
    assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/example");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ success: false, errors: [{ message: "forbidden" }] }), { status: 403 });
  });
  await assert.rejects(api("accounts/example"), /failed \(403\).*forbidden/);
});

test("pagination follows numbered pages and cursor pages", async () => {
  const numbered = [];
  const items = await listAll(async path => {
    const page = Number(new URL(`https://example.com/${path}`).searchParams.get("page"));
    numbered.push(page);
    return { result: [{ id: page }], result_info: { total_pages: 3 } };
  }, "resources");
  assert.deepEqual(numbered, [1, 2, 3]);
  assert.equal(items.length, 3);
  const paths = [];
  await listAll(async path => {
    paths.push(path);
    return { result: [{ id: paths.length }], result_info: { cursors: { after: paths.length === 1 ? "next" : null } } };
  }, "resources");
  assert.equal(paths.length, 2);
  assert.match(paths[1], /cursor=next/);
});

test("single-page APIs may return more than the requested page size", async () => {
  let calls = 0;
  const result = await listAll(async () => {
    calls++;
    return { result: Array.from({ length: 150 }, (_, id) => ({ id })) };
  }, "gateway/lists");
  assert.equal(result.length, 150);
  assert.equal(calls, 1);
});

test("malformed and non-progressing pagination is rejected", async () => {
  await assert.rejects(listAll(async () => ({ result: {} }), "items"), /did not return an array/);
  await assert.rejects(listAll(async () => ({ result: [], result_info: { total_pages: 2 } }), "items"), /empty page/);
  await assert.rejects(listAll(async () => ({ result: [{}], result_info: { cursors: { after: "same" } } }), "items"), /repeated/);
});

function discoveryFixture() {
  const tf = config().terraform;
  const records = {};
  for (const [group, route] of Object.entries({
    access_lists: "gateway/lists", policies: "access/policies", applications: "access/apps",
  })) {
    records[route] = Object.entries(tf.endpoints).map(([key, endpoint]) => ({
      id: `${key}-${group}`, name: group === "policies" ? endpoint.policy_name : endpoint.list_name,
      type: group === "applications" ? "self_hosted" : "IP",
      domain: `${tf.hostname}${endpoint.path}`,
    }));
  }
  const api = async path => {
    const route = path.split("?")[0].split("/").slice(2).join("/");
    assert.ok(records[route], `Unexpected request: ${path}`);
    return { result: records[route] };
  };
  return { tf, records, api };
}

test("discovery adopts only the six Access resources and repeats without duplicates", async () => {
  const { tf, api } = discoveryFixture();
  const result = await discover(api, tf);
  assert.equal(Object.values(result).flatMap(Object.values).length, 6);
  assert.equal(Object.hasOwn(result, "rules_lists"), false);
  const again = await discover(api, { ...tf, existing_resources: result });
  assert.deepEqual(again, result);
});

test("legacy Rules-list state does not trigger discovery or re-adoption", async () => {
  const { tf, api } = discoveryFixture();
  const state = new Map([['cloudflare_list.relay["gitea"]', "preserved-rules-list"]]);
  const result = await discover(api, tf, state);
  assert.deepEqual(Object.keys(result).sort(), ["access_lists", "applications", "policies"]);
  assert.equal(Object.values(result).flatMap(Object.values).length, 6);
});

test("explicit IDs and Terraform state take priority over names", async () => {
  const { tf, records, api } = discoveryFixture();
  records["access/policies"][0].name = "a previous name";
  tf.existing_resources.policies.github = "github-policies";
  assert.equal((await discover(api, tf)).policies.github, "github-policies");
  delete tf.existing_resources.policies.github;
  const state = new Map([['cloudflare_zero_trust_access_policy.relay["github"]', "github-policies"]]);
  assert.equal((await discover(api, tf, state)).policies.github, "github-policies");
  tf.existing_resources.policies.github = "different-policy";
  await assert.rejects(discover(api, tf, state), /already managed with a different ID/);
});

test("missing resources are created, but missing explicit IDs and ambiguous matches fail", async () => {
  const fixture = discoveryFixture();
  fixture.records["gateway/lists"] = [];
  assert.deepEqual((await discover(fixture.api, fixture.tf)).access_lists, {});
  fixture.tf.existing_resources.access_lists.github = "missing";
  await assert.rejects(discover(fixture.api, fixture.tf), /was not found/);
  const ambiguous = discoveryFixture();
  ambiguous.records["access/policies"].push({ ...ambiguous.records["access/policies"][0], id: "duplicate" });
  await assert.rejects(discover(ambiguous.api, ambiguous.tf), /Ambiguous/);
});

test("adoption refuses wrong list types and applications on different hostnames", async () => {
  const wrongType = discoveryFixture();
  wrongType.records["gateway/lists"][0].type = "DOMAIN";
  await assert.rejects(discover(wrongType.api, wrongType.tf), /not an IP list/);
  const wrongPath = discoveryFixture();
  wrongPath.tf.existing_resources.applications.github = "github-applications";
  wrongPath.records["access/apps"][0].domain = "unrelated.example.com/wrong";
  await assert.rejects(discover(wrongPath.api, wrongPath.tf), /configured hostname/);
});

test("known application IDs can change paths in place without duplicating applications", async () => {
  for (const managed of [false, true]) {
    const { tf, api } = discoveryFixture();
    tf.endpoints.github.path = "/new/github";
    tf.endpoints.gitea.path = "/new/socket";
    const state = new Map();
    for (const key of ["github", "gitea"]) {
      if (managed) {
        state.set(`cloudflare_zero_trust_access_application.relay["${key}"]`, `${key}-applications`);
      } else {
        tf.existing_resources.applications[key] = `${key}-applications`;
      }
    }
    const result = await discover(api, tf, state);
    assert.deepEqual(result.applications, { github: "github-applications", gitea: "gitea-applications" });
  }
});

test("managed state traversal supports empty state and nested modules", () => {
  assert.equal(managedResources({ format_version: "1.0" }).size, 0);
  const state = { values: { root_module: {
    resources: [{ address: "first", values: { id: "a" } }],
    child_modules: [{ resources: [{ address: "nested", values: { id: "b" } }] }],
  } } };
  assert.deepEqual([...managedResources(state)], [["first", "a"], ["nested", "b"]]);
});

function verificationFixture(mode = "custom_domain", env = {}) {
  const { terraform: tf } = config(env);
  const deployment = {
    account_id: tf.cloudflare_account_id, worker_name: tf.worker_name, endpoint_mode: mode,
    hostname: tf.hostname, zone_id: tf.cloudflare_zone_id,
    source_ips: { github: ["192.30.252.0/22"], gitea: ["203.0.113.10"] },
    endpoints: {},
  };
  const responses = {};
  for (const [key, endpoint] of Object.entries(tf.endpoints)) {
    deployment.endpoints[key] = {
      path: endpoint.path, access_list_id: `${key}-access`,
      policy_id: `${key}-policy`, application_id: `${key}-app`,
    };
    responses[`gateway/lists/${key}-access/items`] = [{ value: `${deployment.source_ips[key][0]}${key === "gitea" ? "/32" : ""}` }];
    responses[`access/policies/${key}-policy`] = { decision: "non_identity", include: [{ ip_list: { id: `${key}-access` } }] };
    responses[`access/apps/${key}-app`] = {
      type: "self_hosted", domain: `${tf.hostname}${endpoint.path}`,
      destinations: [{ type: "public", uri: `${tf.hostname}${endpoint.path}` }],
      policies: [{ id: `${key}-policy` }],
    };
  }
  responses[`workers/scripts/${tf.worker_name}/settings`] = {
    bindings: [
      { name: "GITHUB_HOOK_RELAY", type: "durable_object_namespace", class_name: "GithubHookRelay", namespace_id: "namespace" },
      { name: "GITHUB_WEBHOOK_SECRET", type: "secret_text" },
      { name: "GITHUB_RELAY_WEBSOCKET_SECRET", type: "secret_text" },
      { name: "CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH", type: "plain_text", text: tf.endpoints.github.path },
      { name: "CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH", type: "plain_text", text: tf.endpoints.gitea.path },
    ],
    compatibility_date: source.compatibility_date,
    observability: { enabled: true, traces: { enabled: true } },
  };
  responses[`workers/scripts/${tf.worker_name}/subdomain`] = { enabled: mode === "workers_dev", previews_enabled: false };
  responses[`workers/services/${tf.worker_name}`] = { default_environment: { script: { migration_tag: source.migrations.at(-1).tag } } };
  responses["workers/durable_objects/namespaces"] = [{ id: "namespace", class: "GithubHookRelay", script: tf.worker_name, use_sqlite: true }];
  responses["workers/domains"] = [{ hostname: tf.hostname, service: tf.worker_name, zone_id: tf.cloudflare_zone_id }];
  const api = async path => {
    const route = path.split("?")[0].split("/").slice(2).join("/");
    assert.ok(Object.hasOwn(responses, route), `Unexpected request: ${path}`);
    return { result: responses[route] };
  };
  return { deployment, responses, api };
}

test("verification checks exact membership and all links for both endpoint modes", async () => {
  for (const mode of ["custom_domain", "workers_dev"]) {
    for (const paths of [{}, {
      CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH: "/custom/github-hook",
      CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH: "/custom/socket",
    }]) {
      const { api, deployment } = verificationFixture(mode, paths);
      await verify(api, deployment, source);
    }
  }
});

for (const [label, mutate, expected] of [
  ["incorrect membership", data => { data["gateway/lists/github-access/items"] = [{ value: "198.51.100.0/24" }]; }, /Zero Trust IP list/],
  ["extra include rule", data => { data["access/policies/github-policy"].include.push({ everyone: {} }); }, /solely/],
  ["identity login decision", data => { data["access/policies/github-policy"].decision = "allow"; }, /solely/],
  ["extra policy", data => { data["access/apps/github-app"].policies.push({ id: "other" }); }, /policy link/],
  ["incorrect path", data => { data["access/apps/github-app"].domain += "/wrong"; }, /incorrect path/],
  ["extra application destination", data => { data["access/apps/github-app"].destinations.push({ type: "public", uri: "unrelated.example.com" }); }, /incorrect path/],
  ["missing binding", data => { data[`workers/scripts/${source.name}/settings`].bindings.shift(); }, /namespace/],
  ["wrong storage backend", data => { data["workers/durable_objects/namespaces"][0].use_sqlite = false; }, /namespace/],
  ["wrong migration tag", data => { data[`workers/services/${source.name}`].default_environment.script.migration_tag = "wrong"; }, /migration tag/],
  ["wrong compatibility date", data => { data[`workers/scripts/${source.name}/settings`].compatibility_date = "2020-01-01"; }, /compatibility date/],
  ["disabled traces", data => { data[`workers/scripts/${source.name}/settings`].observability.traces.enabled = false; }, /observability/],
  ["missing secret", data => { data[`workers/scripts/${source.name}/settings`].bindings = data[`workers/scripts/${source.name}/settings`].bindings.filter(item => item.name !== "GITHUB_WEBHOOK_SECRET"); }, /missing secret/],
  ["missing route variable", data => { data[`workers/scripts/${source.name}/settings`].bindings.pop(); }, /path binding/],
  ["wrong route variable", data => { data[`workers/scripts/${source.name}/settings`].bindings.at(-1).text = "/wrong"; }, /path binding/],
  ["wrong route binding type", data => { data[`workers/scripts/${source.name}/settings`].bindings.at(-1).type = "secret_text"; }, /path binding/],
  ["preview exposure", data => { data[`workers/scripts/${source.name}/subdomain`].previews_enabled = true; }, /exposure/],
  ["workers.dev bypass", data => { data[`workers/scripts/${source.name}/subdomain`].enabled = true; }, /exposure/],
  ["wrong custom domain", data => { data["workers/domains"][0].service = "wrong"; }, /Custom domain/],
]) {
  test(`verification rejects ${label}`, async () => {
    const { api, deployment, responses } = verificationFixture();
    mutate(responses);
    await assert.rejects(verify(api, deployment, source), expected);
  });
}
