import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve("plugins/botspace");
const hooks = JSON.parse(await readFile(join(root, "hooks/hooks.json"), "utf8")).hooks;
async function run(cwd, event = "SessionStart", extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root };
  for (const key of ["BOTSPACE_DIR", "BOTSPACE_PROFILE", "BOTSPACE_CONNECTOR"]) delete env[key];
  Object.assign(env, extraEnv);
  const { stdout, stderr } = await exec("/bin/sh", ["-c", hooks[event][0].hooks[0].command], {
    cwd, env, timeout: 3000,
  });
  assert.equal(stderr, "");
  const output = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, event);
  return output.additionalContext;
}

test("native activation works before setup and carries collaboration into subagents", async (t) => {
  await mkdir(".cache", { recursive: true });
  const dir = await mkdtemp(resolve(".cache/hooks-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await run(dir);
  assert.match(first, /No usable connection/);
  assert.match(first, /Do not require the user to name the plugin/);
  assert.ok(first.includes(join(root, "skills/collaborate/SKILL.md")));
  assert.deepEqual(await readdir(dir), []); // Startup doesn't create setup or processes.
  assert.match(await run(dir, "SubagentStart"), /Leave onboarding, connection activation, and pause\/resume to the parent/);
  for (const event of Object.keys(hooks)) {
    const worker = await run(dir, event, { BOTSPACE_CONNECTOR: "1" });
    assert.match(worker, /Do not onboard, start listeners, or call send\/reply\/ack/);
    assert.doesNotMatch(worker, /No usable connection/);
  }
});

test("activation reuses profiles, preserves pause, excludes credentials, and tolerates damaged setup", async (t) => {
  await mkdir(".cache", { recursive: true });
  const dir = await mkdtemp(resolve(".cache/hooks-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = join(dir, ".botspace");
  await mkdir(join(store, "profiles"), { recursive: true });
  const config = join(store, "identity.json");
  await writeFile(config, JSON.stringify({ token: "SECRET_TOKEN" }));
  await writeFile(config + ".listener.stop", "stop\n");
  const registry = JSON.stringify({ workspaces: { team: {
    name: "reviewer", config, workspace: "https://example.com/w/team#invite=SECRET_INVITE",
    automation: { args: ["--runtime", "claude", "--allow-from", "SECRET_SENDER"] },
  } } });
  await writeFile(join(store, "profiles/reviewer.json"), registry);
  await writeFile(join(store, "profiles/broken.json"), "{");
  const snapshot = await run(dir);
  assert.match(snapshot, /"profile":"reviewer"/);
  assert.match(snapshot, /"paused":true/);
  assert.match(snapshot, /"runtime":"claude"/);
  assert.match(snapshot, /could not be read; do not replace/);
  assert.doesNotMatch(snapshot, /SECRET_/);
  assert.equal(await readFile(config + ".listener.stop", "utf8"), "stop\n");
  assert.equal(await readFile(join(store, "profiles/reviewer.json"), "utf8"), registry);
  const custom = await run(dir, "SessionStart", { BOTSPACE_DIR: store, BOTSPACE_PROFILE: "reviewer" });
  assert.match(custom, /"profile":"reviewer"/);
  assert.doesNotMatch(custom, /Profile "broken"/);
  await rm(config + ".listener.stop");
  assert.match(await run(dir), /"paused":false/);
});
