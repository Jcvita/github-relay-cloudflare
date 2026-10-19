import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { unstable_dev } from "wrangler";
import { parse as parseToml } from "smol-toml";
import { configuration, projectDir } from "../deploy.mjs";

test("compiled Rust Worker and Durable Object use deployed runtime path bindings", { timeout: 120000 }, async t => {
  const workerDir = resolve(projectDir, "..", "githook-relay-worker");
  const source = parseToml(await readFile(join(workerDir, "wrangler.toml"), "utf8"));
  const { wrangler } = configuration({
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_ZONE_ID: "abcdef0123456789abcdef0123456789",
    CLOUDFLARE_ACCESS_APPLICATION_DOMAIN: "relay.example.com",
    GITEA_SERVER_PUBLIC_IPS: "203.0.113.10",
    CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH: "/custom/github-hook",
    CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH: "/custom/socket",
  }, source, workerDir);
  // Only local test credentials; no Cloudflare API calls or persisted DO state.
  const webhookSecret = "runtime-test-webhook";
  await mkdir(join(projectDir, ".generated"), { recursive: true });
  const tempDir = await mkdtemp(join(projectDir, ".generated", "runtime-test-"));
  const configPath = join(tempDir, "wrangler.json");
  const options = {
    config: configPath, local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0,
    persist: false, logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  };
  let worker;
  try {
    await writeFile(join(tempDir, ".dev.vars"),
      `GITHUB_WEBHOOK_SECRET="${webhookSecret}"\nGITHUB_RELAY_WEBSOCKET_SECRET="runtime-test-websocket"\n`);
    await writeFile(configPath, JSON.stringify(wrangler));
    worker = await unstable_dev(wrangler.main, options);
    const get = path => worker.fetch(`http://localhost${path}`);
    await t.test("custom webhook reaches the Durable Object and accepts signed ping", async () => {
      assert.equal((await get("/custom/github-hook")).status, 405);
      const body = JSON.stringify({ hook_id: 42, zen: "Runtime bindings work" });
      const signature = `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
      const response = await worker.fetch("http://localhost/custom/github-hook", {
        method: "POST", body,
        headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": signature },
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "OK");
      assert.equal((await worker.fetch("http://localhost/custom/github-hook", { method: "POST" })).status, 403);
    });
    await t.test("custom WebSocket path reaches the Durable Object upgrade check", async () => {
      assert.equal((await get("/custom/socket")).status, 426);
      assert.equal((await worker.fetch("http://localhost/custom/socket", { method: "POST" })).status, 405);
      const upgrade = authorization => new Promise((done, reject) => {
        const req = request({
          hostname: worker.address, port: worker.port, path: "/custom/socket",
          headers: {
            Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", Authorization: authorization,
          },
        });
        req.on("upgrade", (response, socket) => {
          socket.destroy();
          done(response.statusCode);
        });
        req.on("response", response => {
          response.resume();
          done(response.statusCode);
        });
        req.on("error", reject);
        req.setTimeout(10000, () => req.destroy(new Error("WebSocket upgrade timed out")));
        req.end();
      });
      assert.equal(await upgrade("Bearer wrong-test-secret"), 401);
      assert.equal(await upgrade("Bearer runtime-test-websocket"), 101);
    });
    await t.test("old and unconfigured paths are no longer served", async () => {
      for (const path of ["/relay/webhooks/github/push", "/relay/ws", "/custom/github-hook/extra", "/custom/socket/"]) {
        assert.equal((await get(path)).status, 404, path);
      }
      assert.equal((await get("/")).status, 200);
    });
    await worker.stop();
    worker = undefined;
    delete wrangler.build;
    await t.test("missing or invalid path bindings fail closed instead of restoring defaults", async () => {
      for (const value of [undefined, "/"]) {
        if (value === undefined) delete wrangler.vars.CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH;
        else wrangler.vars.CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH = value;
        await writeFile(configPath, JSON.stringify(wrangler));
        worker = await unstable_dev(wrangler.main, options);
        assert.equal((await get("/custom/socket")).status, 500);
        assert.equal((await get("/relay/webhooks/github/push")).status, 500);
        assert.equal((await get("/")).status, 200);
        await worker.stop();
        worker = undefined;
      }
    });
  } finally {
    if (worker) await worker.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
