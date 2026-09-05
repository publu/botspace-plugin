import WebSocket from "ws";

// Connect before reading: events arriving during the initial read stay observable.
// A socket notification is only a hint; the durable inbox is the source of truth.
export function waitForInbox({
  url,
  token,
  readInbox,
  timeoutMs,
  heartbeatMs = 30000,
  retryBaseMs = 1000,
}) {
  return new Promise((resolve, reject) => {
    let socket,
      retry,
      pulse,
      settled = false,
      last,
      failures = 0,
      activeRead;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(retry);
      clearInterval(pulse);
      activeRead?.abort();
      socket?.terminate();
      error ? reject(error) : resolve(value);
    };
    const deadline = setTimeout(() => {
      if (last && socket?.readyState === WebSocket.OPEN) finish(null, last);
      else
        finish(
          Error(
            "Live inbox connection unavailable before timeout. Check your connection and try again.",
          ),
        );
    }, timeoutMs);
    function connect() {
      if (settled) return;
      const ws = (socket = new WebSocket(url, {
        headers: { Authorization: "Bearer " + token },
        followRedirects: false,
        handshakeTimeout: Math.min(10000, timeoutMs),
        maxPayload: 65536,
        perMessageDeflate: false,
      }));
      let reading = false,
        dirty = false,
        awaitingPong = false,
        opened = 0;
      async function check() {
        if (settled || socket !== ws || ws.readyState !== WebSocket.OPEN)
          return;
        if (reading) {
          dirty = true;
          return;
        }
        reading = true;
        dirty = false;
        const controller = (activeRead = new AbortController());
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
          const result = await readInbox(controller.signal);
          if (settled || socket !== ws || ws.readyState !== WebSocket.OPEN)
            return;
          last = result;
          if (result.events.length) finish(null, result);
        } catch (error) {
          if (settled || socket !== ws || ws.readyState !== WebSocket.OPEN)
            return;
          if ([400, 401, 403, 404].includes(error.status)) finish(error);
          else ws.terminate();
        } finally {
          clearTimeout(timer);
          if (activeRead === controller) activeRead = undefined;
          reading = false;
          if (dirty) void check();
        }
      }
      ws.on("open", () => {
        opened = Date.now();
        void check();
        pulse = setInterval(() => {
          if (awaitingPong) {
            ws.terminate();
            return;
          }
          awaitingPong = true;
          ws.send("ping");
        }, heartbeatMs);
      });
      ws.on("message", (raw) => {
        if (raw.toString() === "pong") {
          awaitingPong = false;
          return;
        }
        try {
          if (JSON.parse(raw.toString()).type === "inbox") void check();
        } catch {
          /* Ignore unknown notifications; never execute their contents. */
        }
      });
      ws.on("unexpected-response", (_request, response) => {
        response.resume();
        if (
          response.statusCode >= 300 &&
          response.statusCode < 500 &&
          response.statusCode !== 429
        )
          finish(
            Error(
              "Live inbox rejected: HTTP " +
                response.statusCode +
                ". Check workspace access.",
            ),
          );
        ws.terminate();
      });
      ws.on("error", () => {
        /* close schedules recovery; never print credentials or headers */
      });
      ws.on("close", (code) => {
        clearInterval(pulse);
        activeRead?.abort();
        if (settled) return;
        if (code === 1008) {
          finish(
            Error(
              "Workspace access changed. Check your membership before reconnecting.",
            ),
          );
          return;
        }
        if (opened && Date.now() - opened >= 30000) failures = 0;
        const delay = Math.min(
          60000,
          retryBaseMs * 2 ** Math.min(failures++, 6),
        );
        retry = setTimeout(connect, delay * (0.75 + Math.random() * 0.5));
      });
    }
    connect();
  });
}
