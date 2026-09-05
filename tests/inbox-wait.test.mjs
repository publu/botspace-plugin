import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { waitForInbox } from "../scripts/inbox-wait.mjs";
const empty = { events: [], cursor: 0, hasMore: false };
async function fixture(t, handler = (_req, res) => res.end()) {
  const server = createServer(handler);
  const wss = new WebSocketServer({ server });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    wss,
    base,
    url: base.replace("http:", "ws:") + "/api/w/test-space/live",
  };
}
test(
  "packaged CLI waits past the old polling interval without repeated HTTP reads",
  { timeout: 25000 },
  async (t) => {
    let reads = 0,
      connections = 0;
    const { base, wss } = await fixture(t, (req, res) => {
      assert.equal(req.headers.authorization, "Bearer test-live-token");
      assert.equal(req.url, "/api/w/test-space/inbox");
      reads++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(empty));
    });
    wss.on("connection", (ws, req) => {
      connections++;
      assert.equal(req.headers.authorization, "Bearer test-live-token");
      assert.equal(req.url, "/api/w/test-space/live?inbox=1");
      // General UI updates must not trigger inbox reads.
      for (let i = 0; i < 8; i++) ws.send(JSON.stringify({ type: "refresh" }));
    });
    await mkdir(".cache/client-tests", { recursive: true });
    const dir = await mkdtemp(".cache/client-tests/live-");
    const config = resolve(dir, "agent.json");
    await writeFile(
      config,
      JSON.stringify({
        workspace: base + "/w/test-space",
        api: base + "/api/w/test-space",
        token: "test-live-token",
      }),
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, [
      resolve("plugins/botspace/scripts/client.mjs"),
      "inbox",
      "--wait",
      "--timeout",
      "17",
      "--config",
      config,
    ]);
    t.after(() => child.kill());
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (x) => (stdout += x));
    child.stderr.on("data", (x) => (stderr += x));
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), empty);
    assert.equal(connections, 1);
    assert.equal(
      reads,
      1,
      "idle connection must not poll at 15s or at timeout",
    );
  },
);
test("notification during initial read is not lost; bursts coalesce; no automatic ack", async (t) => {
  const { wss, url } = await fixture(t);
  let ws,
    reads = 0,
    release;
  wss.on("connection", (s) => (ws = s));
  const pending = waitForInbox({
    url,
    token: "test",
    timeoutMs: 3000,
    readInbox: async () => {
      reads++;
      if (reads === 1) return new Promise((r) => (release = () => r(empty)));
      return { events: [{ id: 7 }], cursor: 7, hasMore: false };
    },
  });
  while (!release) await delay(5);
  for (let i = 0; i < 20; i++)
    ws.send(JSON.stringify({ type: "inbox", eventId: 7 }));
  await delay(20);
  release();
  assert.equal((await pending).events[0].id, 7);
  assert.equal(reads, 2);
});
test("disconnect replays durable inbox even without a new socket notification", async (t) => {
  const { wss, url } = await fixture(t);
  let connections = 0,
    reads = 0,
    ws;
  wss.on("connection", (s) => {
    ws = s;
    connections++;
  });
  const pending = waitForInbox({
    url,
    token: "test",
    timeoutMs: 3000,
    retryBaseMs: 20,
    readInbox: async () => {
      reads++;
      if (reads === 1) {
        setTimeout(() => ws.terminate(), 15);
        return empty;
      }
      return { events: [{ id: 9 }], cursor: 9, hasMore: false };
    },
  });
  assert.equal((await pending).events[0].id, 9);
  assert.equal(connections, 2);
  assert.equal(reads, 2);
});
test("missed keepalive reconnects and rechecks; pong never fetches inbox", async (t) => {
  const { wss, url } = await fixture(t);
  let connections = 0,
    reads = 0;
  wss.on("connection", (ws) => {
    connections++;
    if (connections > 1) ws.on("message", () => ws.send("pong"));
  });
  await waitForInbox({
    url,
    token: "test",
    timeoutMs: 250,
    heartbeatMs: 30,
    retryBaseMs: 10,
    readInbox: async () => {
      reads++;
      return empty;
    },
  });
  assert.equal(connections, 2);
  assert.equal(reads, 2);
});
test("membership revocation stops reconnection instead of retrying forever", async (t) => {
  const { wss, url } = await fixture(t);
  let connections = 0;
  wss.on("connection", (ws) => {
    connections++;
    setTimeout(() => ws.close(1008, "revoked"), 20);
  });
  await assert.rejects(
    waitForInbox({
      url,
      token: "test",
      timeoutMs: 1000,
      readInbox: async () => empty,
    }),
    /access changed/,
  );
  assert.equal(connections, 1);
});
test("HTTP upgrade rejection does not follow redirects or leak the token", async (t) => {
  const server = createServer();
  let attempts = 0;
  server.on("upgrade", (_req, socket) => {
    attempts++;
    socket.end(
      "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/stolen\r\nContent-Length: 0\r\n\r\n",
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  await assert.rejects(
    waitForInbox({
      url: "ws://127.0.0.1:" + server.address().port,
      token: "test-secret",
      timeoutMs: 1000,
      readInbox: async () => empty,
    }),
    /HTTP 302/,
  );
  assert.equal(attempts, 1);
});
