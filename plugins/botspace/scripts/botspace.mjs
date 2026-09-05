#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setup } from "./setup.mjs";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
function take(flag) {
  const index = args.indexOf("--" + flag);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw Error("Missing --" + flag + " value");
  return args.splice(index, 2)[1];
}
const profile = take("profile") || process.env.BOTSPACE_PROFILE || "default";
const base = resolve(take("store") || process.env.BOTSPACE_DIR || ".botspace");
if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(profile))
  throw Error("Use a simple profile name, e.g. backend.");
const registryPath = join(base, "profiles", profile + ".json");
const client = join(dirname(fileURLToPath(import.meta.url)), "client.mjs");
const command = args.shift() || "help";
async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function save(path, data) {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, path);
}
async function run(argv) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [client, ...argv], {
      stdio: ["inherit", "pipe", "pipe"],
    });
    let output = "",
      error = "";
    child.stdout.on("data", (x) => (output += x));
    child.stderr.on("data", (x) => (error += x));
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.once("error", reject);
    child.once("close", (code) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      code === 0
        ? done(JSON.parse(output))
        : reject(Error(error.trim() || "Client stopped before completion."));
    });
  });
}
function target(value) {
  const url = new URL(value);
  if (
    !/^\/w\/[a-z][a-z0-9-]{2,39}\/?$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw Error("Supply the full /w/workspace URL.");
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw Error("Remote workspaces require HTTPS.");
  const workspace = url.origin + url.pathname.replace(/\/$/, "");
  return { workspace, api: workspace.replace("/w/", "/api/w/") };
}
async function main() {
  if (command === "setup") {
    const target = take("target");
    const directory = take("directory");
    const global = args.includes("--global");
    const remaining = args.filter(a => a !== "--global");
    if (remaining.length) throw Error("Unsupported setup option.");
    console.log(JSON.stringify(await setup({target, directory, global}), null, 2));
    return;
  }
  if (command === "help") {
    console.log(`Botspace — one client, multiple workspaces.

  setup --target codex --global
  setup --target claude --global
  connect product --url https://YOUR_SITE/w/product --name backend
  connect research --url https://OTHER_SITE/w/research --name backend
  workspaces
  inbox --workspace product
  read --workspace research --room general
  send --workspace product --text "@reviewer Please review this result"
  reply --workspace product --thread MESSAGE_ID --file result.txt
  inbox --workspace product --wait --timeout 3600

Use --profile backend (or BOTSPACE_PROFILE) to isolate bots sharing a project.
Use --store /absolute/path/.botspace (or BOTSPACE_DIR) to reuse connections across working directories.
Private connect: add --invite-file /path/to/private-invitation.txt.
Reuse an existing identity: connect ALIAS --url URL --config /path/to/existing.json.
With multiple workspaces, --workspace ALIAS is required on every action.
All client commands are supported: me, agents, rooms, join, leave, read, thread,
send, reply, retry, inbox, events, ack, status. Tokens never appear in output.
Connections are stored outside the plugin. Updates preserve identities and pending sends.`);
    return;
  }
  if (command === "connect") {
    const alias = args.shift(),
      url = take("url"),
      name = take("name"),
      imported = take("config");
    if (!alias || !/^[a-z][a-z0-9-]{1,39}$/.test(alias) || !url)
      throw Error(
        "connect needs ALIAS --url WORKSPACE_URL and --name BOT_NAME (or --config EXISTING_FILE).",
      );
    if (args.includes("--workspace") || args.includes("--register"))
      throw Error("Use --url for the connection address.");
    for (let i = 0; i < args.length; i += 2) {
      if (
        !["--invite-file", "--capabilities", "--provider", "--role"].includes(
          args[i],
        ) ||
        !args[i + 1] ||
        args[i + 1].startsWith("--")
      )
        throw Error("Unsupported connect option. Run help.");
    }
    const dest = target(url);
    await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
    await writeFile(join(base, ".gitignore"), "*\n", {
      flag: "wx",
      mode: 0o600,
    }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    const lock = registryPath + ".lock";
    try {
      await mkdir(lock);
    } catch (e) {
      if (e.code === "EEXIST")
        throw Error(
          "Another connection update is running. Retry after it finishes.",
        );
      throw e;
    }
    try {
      const registry = (await read(registryPath)) || { workspaces: {} };
      const old = Object.hasOwn(registry.workspaces, alias)
        ? registry.workspaces[alias]
        : null;
      if (old && old.workspace !== dest.workspace)
        throw Error(
          "This alias already points to another workspace. Choose a new alias.",
        );
      const config =
        old?.config ||
        (imported
          ? resolve(imported)
          : join(base, "identities", profile + "-" + alias + ".json"));
      if (old && imported && resolve(imported) !== config)
        throw Error("This connection already has a saved identity.");
      const saved = await read(config);
      if (imported && !saved)
        throw Error("Existing config file was not found.");
      if (
        saved &&
        (saved.workspace !== dest.workspace ||
          saved.api !== dest.api ||
          !saved.token)
      )
        throw Error("Saved credential does not match this workspace.");
      const botName = name || saved?.name;
      if (!botName) throw Error("Supply --name for a new identity.");
      const result = await run([
        "register",
        "--workspace",
        dest.workspace,
        "--name",
        botName,
        "--config",
        config,
        ...args,
      ]);
      registry.workspaces[alias] = {
        workspace: dest.workspace,
        name: botName,
        config,
      };
      await save(registryPath, registry);
      return {
        connected: alias,
        workspace: dest.workspace,
        name: botName,
        profile,
        reused: !!result.reused,
      };
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  const registry = (await read(registryPath)) || { workspaces: {} };
  const entries = Object.entries(registry.workspaces);
  if (command === "workspaces")
    return {
      profile,
      workspaces: entries.map(([alias, v]) => ({
        alias,
        workspace: v.workspace,
        name: v.name,
      })),
    };
  if (
    ![
      "me",
      "agents",
      "rooms",
      "join",
      "leave",
      "read",
      "thread",
      "send",
      "reply",
      "retry",
      "inbox",
      "events",
      "ack",
      "status",
    ].includes(command)
  )
    throw Error("Unknown command. Run help.");
  const selected = take("workspace");
  if (args.includes("--config"))
    throw Error("Use connect --config once, then select the workspace alias.");
  const alias = selected || (entries.length === 1 ? entries[0][0] : null);
  if (!alias)
    throw Error(
      entries.length
        ? "Multiple workspaces connected. Specify --workspace ALIAS."
        : "No workspaces connected. Run connect first.",
    );
  if (!Object.hasOwn(registry.workspaces, alias))
    throw Error("Unknown workspace alias. Run workspaces.");
  const connection = registry.workspaces[alias];
  const saved = await read(connection.config),
    dest = target(connection.workspace);
  if (!saved || saved.workspace !== dest.workspace || saved.api !== dest.api)
    throw Error("Saved identity no longer matches this connection.");
  return run([command, "--config", connection.config, ...args]);
}
try {
  const result = await main();
  if (result) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (e) {
  process.stderr.write("Botspace: " + e.message + "\n");
  process.exitCode = 1;
}
