import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

test("workspace connections persist, isolate credentials, refuse ambiguous sends, and reuse existing identities", async () => {
  await mkdir(".cache", { recursive: true });
  const store = resolve(await mkdtemp(".cache/connections-"));
  let registrations = 0;
  const posts = [];
  const server = createServer(async (req, res) => {
    const slug = req.url.split("/")[3];
    const send = (body, code = 200) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.endsWith("/agents")) {
      registrations++;
      return send({
        agent: { id: slug, name: body.name },
        token: "test-token-" + slug,
      });
    }
    assert.equal(req.headers.authorization, "Bearer test-token-" + slug);
    if (req.url.endsWith("/me"))
      return send({ id: slug, agent: { name: "backend" }, rooms: [] });
    if (req.url.endsWith("/posts")) {
      posts.push({ slug, body });
      return send(body, 201);
    }
    return send({ events: [], cursor: 0, hasMore: false });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const run = (...args) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [
        "plugins/botspace/scripts/botspace.mjs",
        ...args,
        "--store",
        store,
        "--profile",
        "backend",
      ]);
      let out = "",
        err = "";
      child.stdout.on("data", (x) => (out += x));
      child.stderr.on("data", (x) => (err += x));
      child.on("close", (code) => done({ code, out, err }));
    });
  try {
    for (const [alias, slug] of [
      ["product", "product"],
      ["research", "research"],
    ]) {
      const connected = await run(
        "connect",
        alias,
        "--url",
        base + "/w/" + slug,
        "--name",
        "backend",
      );
      assert.equal(connected.code, 0, connected.err);
      assert.ok(!connected.out.includes("test-token"));
    }
    assert.equal(registrations, 2);
    // Rejoining a saved identity must retain its worker and sender choices.
    const profilePath = resolve(store, "profiles/backend.json");
    const configured = JSON.parse(await readFile(profilePath, "utf8"));
    const automation = { args: ["--runtime", "codex", "--directory", store, "--allow-from", "reviewer"] };
    configured.workspaces.product.automation = automation;
    await writeFile(profilePath, JSON.stringify(configured));
    const repeat = await run(
      "connect",
      "product",
      "--url",
      base + "/w/product",
      "--name",
      "backend",
    );
    assert.equal(JSON.parse(repeat.out).reused, true);
    assert.deepEqual(JSON.parse(await readFile(profilePath, "utf8")).workspaces.product.automation, automation);
    assert.equal(registrations, 2);
    assert.equal((await run("send", "--text", "Do not guess")).code, 1);
    assert.equal(posts.length, 0);
    assert.equal(
      (
        await run(
          "send",
          "--workspace",
          "research",
          "--text",
          "A research result",
        )
      ).code,
      0,
    );
    assert.equal(posts[0].slug, "research");
    assert.equal(
      (
        await run(
          "connect",
          "product",
          "--url",
          base + "/w/elsewhere",
          "--name",
          "backend",
        )
      ).code,
      1,
    );
    assert.equal((await run("inbox", "--workspace", "unknown")).code, 1);
    const listed = await run("workspaces");
    assert.equal(JSON.parse(listed.out).workspaces.length, 2);
    assert.ok(!listed.out.includes("test-token"));
    const identity = resolve(store, "identities/backend-product.json");
    assert.equal((await stat(identity)).mode & 0o777, 0o600);
    const imported = await run(
      "connect",
      "existing",
      "--url",
      base + "/w/product",
      "--config",
      identity,
    );
    assert.equal(imported.code, 0, imported.err);
    assert.equal(registrations, 2);
    const registry = JSON.parse(
      await readFile(resolve(store, "profiles/backend.json"), "utf8"),
    );
    assert.equal(registry.workspaces.existing.config, identity);
    // Never forward a saved token when its API destination has been changed.
    const saved = JSON.parse(await readFile(identity, "utf8"));
    saved.api = base + "/api/w/research";
    await writeFile(identity, JSON.stringify(saved));
    assert.equal((await run("me", "--workspace", "product")).code, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
