import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createInstalledPayload } from "./fixtures/install-root.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "scripts", "apply-host-config.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 60_000 });
}

async function createWorkspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kimi-cu-apply-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

test("writes a host configuration from a verified installation state", async (t) => {
  const directory = await createWorkspace(t);
  const fixture = await createInstalledPayload(directory);
  const configPath = path.join(await createWorkspace(t), "mcp.json");

  const result = runCli([
    "--host", "workbuddy",
    "--config-path", configPath,
    "--install-root", directory,
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.action, "created");
  assert.equal(summary.source.mode, "installed");
  assert.equal(summary.source.version, "9.9.9");
  assert.equal(summary.source.fingerprint, fixture.state.fingerprint);
  const canonicalRoot = await realpath(fixture.payloadRoot);
  assert.equal(summary.server.command, `${canonicalRoot.replaceAll("\\", "/")}/runtime/node-repl.exe`);
  assert.equal(summary.server.cwd, canonicalRoot.replaceAll("\\", "/"));

  const server = (await readJson(configPath)).mcpServers["kimi-cu"];
  assert.equal(server.command, summary.server.command);
  assert.equal(server.cwd, summary.server.cwd);

  const before = await readJson(configPath);
  before.mcpServers["kimi-cu"].args = ["--stale"];
  before.theme = "dark";
  await writeFile(configPath, JSON.stringify(before, null, 2));
  const updated = runCli([
    "--host", "workbuddy",
    "--config-path", configPath,
    "--install-root", directory,
    "--json",
  ]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(JSON.parse(updated.stdout).restoreCommand, /^Copy-Item -LiteralPath '/);

  const again = runCli([
    "--host", "workbuddy",
    "--config-path", configPath,
    "--install-root", directory,
  ]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Action: unchanged/);
});

test("repository mode is explicit and points at src/runtime", async (t) => {
  const directory = await createWorkspace(t);
  const configPath = path.join(directory, "mcp.json");

  const result = runCli([
    "--host", "antigravity",
    "--config-path", configPath,
    "--repo-root", repoRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /development only/);

  const server = (await readJson(configPath)).mcpServers["kimi-cu"];
  assert.equal(server.command, `${repoRoot.replaceAll("\\", "/")}/src/runtime/node-repl.exe`);
});

test("removes only the managed server", async (t) => {
  const directory = await createWorkspace(t);
  const configPath = path.join(directory, "mcp.json");
  const original = { mcpServers: { alpha: { command: "alpha.exe" } }, theme: "dark" };
  await writeFile(configPath, JSON.stringify(original, null, 2));

  const add = runCli(["--host", "claude-desktop", "--config-path", configPath, "--repo-root", repoRoot]);
  assert.equal(add.status, 0, add.stderr);

  const remove = runCli([
    "--host", "claude-desktop",
    "--config-path", configPath,
    "--remove",
    "--json",
  ]);
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(JSON.parse(remove.stdout).action, "removed");

  const written = await readJson(configPath);
  assert.equal(written.theme, "dark");
  assert.deepEqual(Object.keys(written.mcpServers), ["alpha"]);
});

test("refuses TOML hosts and invalid arguments without writing files", async (t) => {
  const directory = await createWorkspace(t);
  const configPath = path.join(directory, "config.json");

  const codex = runCli(["--host", "codex", "--config-path", configPath, "--repo-root", repoRoot]);
  assert.equal(codex.status, 2);
  assert.match(codex.stderr, /TOML/);
  await assert.rejects(stat(configPath));

  const both = runCli([
    "--host", "workbuddy",
    "--config-path", configPath,
    "--repo-root", repoRoot,
    "--install-root", directory,
  ]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /exactly one/);

  const relative = runCli(["--host", "workbuddy", "--config-path", "relative.json", "--repo-root", repoRoot]);
  assert.equal(relative.status, 2);
  assert.match(relative.stderr, /absolute path/);

  const managed = path.join(directory, ".kimi-code", "plugins", "managed", "kimi-cu-win", "mcp.json");
  const official = runCli(["--host", "workbuddy", "--config-path", managed, "--repo-root", repoRoot]);
  assert.equal(official.status, 2);
  assert.match(official.stderr, /managed plugin directory/);
  await assert.rejects(stat(managed));
});

test("refuses to write inside the installation directory", async (t) => {
  const directory = await createWorkspace(t);
  await createInstalledPayload(directory);
  const configPath = path.join(directory, "mcp.json");
  const result = runCli(["--host", "workbuddy", "--config-path", configPath, "--install-root", directory]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /inside the installation or payload directory/);
  await assert.rejects(stat(configPath));
});

test("fails closed when the installation state is missing", async (t) => {
  const directory = await createWorkspace(t);
  const configPath = path.join(directory, "mcp.json");
  const result = runCli(["--host", "workbuddy", "--config-path", configPath, "--install-root", directory]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No installed payload found/);
  await assert.rejects(stat(configPath));
});
