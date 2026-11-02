import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyHostConfig, assertConfigUnchanged, readHostConfig, replaceWithRetry } from "../scripts/lib/host-config-file.mjs";

const entry = {
  command: "C:/payload/runtime/node-repl.exe",
  args: [],
  cwd: "C:/payload",
  env: { PATH: "C:/Program Files/nodejs;%PATH%" },
};

async function createDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kimi-cu-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

test("merges only the managed server and backs up the original file", async (t) => {
  const directory = await createDirectory(t);
  const configPath = path.join(directory, "mcp.json");
  const original = `{
  "theme": "dark",
  "mcpServers": {
    "alpha": {
      "command": "alpha.exe"
    }
  }
}\n`;
  await writeFile(configPath, original);

  const result = await applyHostConfig({ configPath, entry });
  assert.equal(result.action, "updated");
  assert.ok(result.backupPath);
  assert.equal(await readFile(result.backupPath, "utf8"), original);

  const written = await readJson(configPath);
  assert.equal(written.theme, "dark");
  assert.deepEqual(written.mcpServers.alpha, { command: "alpha.exe" });
  assert.deepEqual(written.mcpServers["kimi-cu"], entry);
});

test("repeated application is idempotent and does not create extra backups", async (t) => {
  const directory = await createDirectory(t);
  const configPath = path.join(directory, "mcp.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }, null, 2));

  await applyHostConfig({ configPath, entry });
  const before = (await readdir(directory)).sort();
  const second = await applyHostConfig({ configPath, entry });

  assert.equal(second.action, "unchanged");
  assert.equal(second.backupPath, null);
  assert.deepEqual((await readdir(directory)).sort(), before);
});

test("refuses invalid JSON and leaves the original bytes untouched", async (t) => {
  const directory = await createDirectory(t);
  const configPath = path.join(directory, "mcp.json");
  const original = '{ "mcpServers": { broken }';
  await writeFile(configPath, original);

  const failure = await applyHostConfig({ configPath, entry }).catch((error) => error);
  assert.match(failure.message, /not valid JSON/);
  assert.doesNotMatch(failure.message, /broken/);
  assert.equal(await readFile(configPath, "utf8"), original);

  await writeFile(configPath, JSON.stringify({ mcpServers: [] }));
  await assert.rejects(applyHostConfig({ configPath, entry }), /mcpServers must be a JSON object/);
});

test("dry runs report the planned action without touching the disk", async (t) => {
  const directory = await createDirectory(t);
  const configPath = path.join(directory, "mcp.json");

  const plan = await applyHostConfig({ configPath, entry, dryRun: true });
  assert.equal(plan.action, "would-create");
  assert.deepEqual(await readdir(directory), []);
});

test("removes only the managed server and keeps a backup", async (t) => {
  const directory = await createDirectory(t);
  const configPath = path.join(directory, "mcp.json");
  await writeFile(
    configPath,
    JSON.stringify({ mcpServers: { alpha: { command: "alpha.exe" }, "kimi-cu": entry } }, null, 2),
  );

  const result = await applyHostConfig({ configPath, entry, remove: true });
  assert.equal(result.action, "removed");
  assert.ok(result.backupPath);
  assert.ok((await readFile(result.backupPath, "utf8")).includes("kimi-cu"));

  const written = await readJson(configPath);
  assert.deepEqual(Object.keys(written.mcpServers), ["alpha"]);

  const second = await applyHostConfig({ configPath, entry, remove: true });
  assert.equal(second.action, "unchanged");
  assert.equal(second.backupPath, null);
});

test("removing a missing configuration is a no-op", async (t) => {
  const directory = await createDirectory(t);
  const result = await applyHostConfig({ configPath: path.join(directory, "mcp.json"), entry, remove: true });
  assert.equal(result.action, "missing");
  assert.deepEqual(await readdir(directory), []);
});

test("preserves indentation, CRLF newlines and strips a UTF-8 BOM", async (t) => {
  const directory = await createDirectory(t);
  const configPath = path.join(directory, "mcp.json");
  const original = '{\r\n    "mcpServers": {}\r\n}\r\n';
  await writeFile(configPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(original, "utf8")]));

  const parsed = await readHostConfig(configPath);
  assert.equal(parsed.indent, "    ");
  assert.equal(parsed.newline, "\r\n");

  await applyHostConfig({ configPath, entry });
  const bytes = await readFile(configPath);
  assert.notEqual(bytes[0], 0xef);
  const written = bytes.toString("utf8");
  assert.ok(written.includes('\r\n    "mcpServers"'));
  assert.equal(written.replaceAll("\r\n", "").includes("\n"), false);
});

test("refuses missing directories and leaves no temporary files", async (t) => {
  const directory = await createDirectory(t);
  const missing = path.join(directory, "missing", "mcp.json");
  await assert.rejects(applyHostConfig({ configPath: missing, entry }), /does not exist/);
  await assert.rejects(applyHostConfig({ configPath: missing, entry, dryRun: true }), /does not exist/);

  const configPath = path.join(directory, "mcp.json");
  await writeFile(configPath, "{}\n");
  await applyHostConfig({ configPath, entry });
  const names = await readdir(directory);
  assert.equal(names.some((name) => name.endsWith(".tmp")), false);
  assert.equal(names.filter((name) => name.includes(".kimi-cu-backup-")).length, 1);
});

test("detects configuration changes between read and write", async (t) => {
  const directory = await createDirectory(t);
  const configPath = path.join(directory, "mcp.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }, null, 2));
  const snapshot = await readHostConfig(configPath);

  await writeFile(configPath, JSON.stringify({ mcpServers: {}, changed: true }, null, 2));
  await assert.rejects(assertConfigUnchanged(configPath, snapshot), /changed on disk/);
});

test("retries replacements while the destination is locked", async () => {
  let attempts = 0;
  await replaceWithRetry("temporary", "destination", {
    delays: [0, 0, 0],
    renameFile: async () => {
      attempts++;
      if (attempts < 3) {
        const error = new Error("locked");
        error.code = "EPERM";
        throw error;
      }
    },
  });
  assert.equal(attempts, 3);

  let permanentAttempts = 0;
  await assert.rejects(
    replaceWithRetry("temporary", "destination", {
      delays: [0, 0],
      renameFile: async () => {
        permanentAttempts++;
        const error = new Error("locked");
        error.code = "EBUSY";
        throw error;
      },
    }),
    /locked \(EBUSY\)/,
  );
  assert.equal(permanentAttempts, 2);
});

test("refuses to write through a symbolic link", async (t) => {
  const directory = await createDirectory(t);
  const target = path.join(directory, "target.json");
  const link = path.join(directory, "link.json");
  await writeFile(target, "{}\n");
  try {
    await symlink(target, link);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("Symbolic link creation is not permitted for this user.");
      return;
    }
    throw error;
  }
  await assert.rejects(applyHostConfig({ configPath: link, entry }), /symbolic link/);
});
