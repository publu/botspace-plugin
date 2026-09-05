import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

test("background connector wakes, queues, owns one process, persists results and stops", async () => {
  await mkdir(".cache", { recursive: true });
  const dir = resolve(await mkdtemp(".cache/listener-"));
  const bin = dir + "/bin";
  await mkdir(bin);
  await writeFile(
    bin + "/codex",
    `#!${process.execPath}\nlet prompt='';for await(const c of process.stdin)prompt+=c;console.log(JSON.stringify({type:'thread.started',thread_id:'owned'}));await new Promise(r=>setTimeout(r,200));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Verified reply'}}));\n`,
    { mode: 0o700 },
  );
  const events = [],
    posts = [],
    acks = [];
  let reads = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, "http://test");
    const send = (v) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(v));
    };
    if (url.pathname.endsWith("/me")) return send({ id: "worker" });
    if (url.pathname.endsWith("/agents"))
      return send({ agents: [{ id: "lead-id", name: "lead" }] });
    if (url.pathname.endsWith("/inbox")) {
      reads++;
      const items = events.filter(
        (e) =>
          e.id > Number(url.searchParams.get("after") || 0) &&
          !acks.includes(e.id),
      );
      return send({ events: items, cursor: items.at(-1)?.id || 0 });
    }
    if (url.pathname.includes("/threads/"))
      return send({
        root: {
          id: "root",
          room: "general",
          author: "lead-id",
          body: "Review",
        },
        replies: [],
      });
    if (url.pathname.endsWith("/posts")) {
      posts.push(body);
      return send(body);
    }
    if (url.pathname.endsWith("/ack")) {
      acks.push(...body.ids);
      return send({ ok: true });
    }
    res.statusCode = 404;
    send({ error: "unknown" });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) =>
    ws.on("message", (m) => {
      if (m.toString() === "ping") ws.send("pong");
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const store = dir + "/store",
    config = store + "/identity.json";
  await mkdir(store + "/profiles", { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      workspace: origin + "/w/test",
      api: origin + "/api/w/test",
      name: "worker",
      agentId: "worker",
      token: "test-token",
    }),
  );
  await writeFile(
    store + "/profiles/worker.json",
    JSON.stringify({
      workspaces: {
        test: { workspace: origin + "/w/test", config, name: "worker" },
      },
    }),
  );
  const command = (...args) =>
    new Promise((resolve) => {
      const p = spawn(
        process.execPath,
        [
          "plugins/botspace/scripts/botspace.mjs",
          ...args,
          "--workspace",
          "test",
          "--profile",
          "worker",
          "--store",
          store,
        ],
        { env: { ...process.env, PATH: bin + ":" + process.env.PATH } },
      );
      let out = "",
        err = "";
      p.stdout.on("data", (x) => (out += x));
      p.stderr.on("data", (x) => (err += x));
      p.on("close", (code) => resolve({ code, out, err }));
    });
  const options = [
    "--runtime",
    "codex",
    "--directory",
    dir,
    "--allow-from",
    "lead",
    "--background",
  ];
  const until = async (fn) => {
    for (let i = 0; i < 100; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error("Condition not reached");
  };
  try {
    const before = await command("onboard");
    assert.equal(JSON.parse(before.out).workspaces[0].configured, false);
    let start = await command("activate", ...options);
    assert.equal(start.code, 0, start.err);
    assert.equal(JSON.parse(start.out).listening, true);
    const duplicate = await command("listen", ...options);
    assert.notEqual(duplicate.code, 0);
    assert.match(duplicate.err, /already has a listener/);
    await until(() => reads > 0);
    const idleReads = reads;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(reads, idleReads, "idle listener should not poll");
    events.push(
      ...[1, 2].map((id) => ({
        id,
        type: "message",
        actor: "lead-id",
        objectId: "root",
        text: "Review",
      })),
    );
    for (const ws of wss.clients) ws.send(JSON.stringify({ type: "inbox" }));
    await until(() => acks.length === 2);
    assert.equal(posts.length, 2);
    assert.notEqual(posts[0].id, posts[1].id);
    const state = JSON.parse(await readFile(config + ".listener.json"));
    assert.equal(state.jobs[1].status, "done");
    assert.equal(state.jobs[2].status, "done");
    assert.equal(state.sessions.root, "owned");
    assert.equal((await command("pause")).code, 0);
    await until(
      async () => !JSON.parse((await command("listener-status")).out).running,
    );
    const configured = JSON.parse((await command("onboard")).out);
    assert.equal(configured.workspaces[0].configured, true);
    start = await command("resume");
    assert.equal(start.code, 0, start.err);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(posts.length, 2, "restart must not repeat completed jobs");
  } finally {
    await command("pause");
    await until(
      async () => !JSON.parse((await command("listener-status")).out).running,
    );
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
