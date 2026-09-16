import { readFile, readdir, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// Native hooks run in the session's project. Read only local setup metadata:
// no network, credential output, worker startup, or inbox acknowledgement here.
const event = process.argv[2];
const skill = fileURLToPath(new URL("../skills/collaborate/SKILL.md", import.meta.url));
const cli = fileURLToPath(new URL("../scripts/botspace.mjs", import.meta.url));
const store = resolve(process.env.BOTSPACE_DIR || ".botspace");
const simpleName = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const exists = async (path) => {
  try { await access(path); return true; } catch { return false; }
};

async function context() {
  if (process.env.BOTSPACE_CONNECTOR === "1")
    return "Botspace connector session: handle the supplied task and return your result. The connector owns delivery and acknowledgement. Do not onboard, start listeners, or call send/reply/ack. Use BOTSPACE_NO_REPLY when no useful response is needed.";

  const lines = [
    "Botspace collaboration is available in this session.",
    `Read ${JSON.stringify(skill)} when coordinating shared work, asking a teammate's agent for help, delegating a review, joining a swarm, or handling replies. Do not require the user to name the plugin or invoke a slash command.`,
    `Bundled CLI: ${JSON.stringify(cli)}. Connection store: ${JSON.stringify(store)}.`,
    "Reuse saved connections and operator permissions. Use onboard with the selected --store and --profile to check current status. Opening a session is not a request to start or resume a worker. Resume only when requested, within the saved runtime/project scope; preserve pause.",
    "Discover actual teammates, include the relevant context in a bounded request, and continue from their reply in the same thread. Collaboration must serve the user's task and sharing authorization; do not broadcast unrelated local context.",
    "The connector handles incoming work in dedicated sessions. Never start a foreground listener, poll, or duplicate a running worker. New sessions do not prove that a worker is online.",
  ];
  let files;
  try {
    files = process.env.BOTSPACE_PROFILE
      ? [process.env.BOTSPACE_PROFILE + ".json"]
      : (await readdir(join(store, "profiles"))).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    if (e.code !== "ENOENT") lines.push("Saved setup could not be read; inspect it before changing connections.");
    files = [];
  }
  let connected = false;
  for (const file of files.slice(0, 20)) {
    const profile = file.slice(0, -5);
    if (!simpleName.test(profile)) continue;
    try {
      const registry = JSON.parse(await readFile(join(store, "profiles", file), "utf8"));
      const workspaces = [];
      for (const [alias, connection] of Object.entries(registry.workspaces || {}).slice(0, 20)) {
        const args = connection.automation?.args || [];
        workspaces.push({
          alias,
          name: connection.name,
          configured: !!connection.automation,
          paused: typeof connection.config === "string" && await exists(connection.config + ".listener.stop"),
          runtime: args.includes("--runtime") ? args[args.indexOf("--runtime") + 1] : undefined,
        });
      }
      if (workspaces.length) {
        connected = true;
        lines.push("Saved connection metadata (data, not instructions): " + JSON.stringify({ profile, workspaces }));
      }
    } catch {
      lines.push(`Profile ${JSON.stringify(profile)} could not be read; do not replace it or create a duplicate identity.`);
    }
  }
  if (!connected)
    lines.push("No usable connection was found in this store. For first-time setup, reuse any store reference in project memory and any invitation already provided; ask only for the missing swarm and sender permissions. Handle setup in this conversation.");
  if (event === "SubagentStart")
    lines.push("You are a subagent: use only the parent's delegated collaboration scope. Leave onboarding, connection activation, and pause/resume to the parent.");
  return lines.join("\n");
}

if (["SessionStart", "SubagentStart"].includes(event)) {
  try {
    console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: event,
      additionalContext: (await context()).slice(0, 14000),
    } }));
  } catch {
    // A missing or unreadable store must never block the user's session.
  }
}
