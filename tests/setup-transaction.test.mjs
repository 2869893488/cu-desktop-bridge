import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readInstallState } from "../scripts/lib/install-state.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setup = path.join(repoRoot, "scripts", "setup.ps1");
const requiredFiles = [
  "bin/launch.mjs", "bin/native-bootstrap.mjs", "bin/agent-readiness.mjs",
  "bin/kimi-cu-mcp.cmd", "bundle.json", "runtime/node-repl.exe",
  "runtime/kernel.mjs", "runtime/trusted-worker.mjs", "runtime/cell-compiler.mjs",
  "runtime/worker-runtime.mjs", "runtime/image-output.mjs",
  "runtime/node_modules/meriyah/package.json", "public/node_modules/@kimi/cu/index.mjs",
  "trusted-service/service.mjs", "skills/kimi-cu/SKILL.md",
  "skills/kimi-cu/references/api.md", "skills/kimi-cu/references/repl.md",
];

async function createSource(root, version) {
  for (const relative of requiredFiles) {
    const destination = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `fixture ${version}: ${relative}\n`);
  }
}

async function createLock(root, source, version) {
  const files = [];
  for (const relative of requiredFiles) {
    const bytes = await readFile(path.join(source, ...relative.split("/")));
    files.push({ path: relative, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const destination = path.join(root, `lock-${version}.json`);
  await writeFile(destination, JSON.stringify({
    schemaVersion: 1,
    payload: { name: "kimi-cu-fixture", version, files },
    node: { minimumVersion: "24.15.0" },
  }));
  return destination;
}

function runSetup(args, expectedStatus = 0) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-File", setup, ...args, "-Verbose"], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expectedStatus, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

test("local payload install is hash-checked, idempotent, upgradeable and reversible", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async (t) => {
  const temporary = await mkdir(path.join(os.tmpdir(), `kimi-cu-setup-${process.pid}-`), { recursive: true });
  const root = path.join(temporary, "中文 user");
  const source = path.join(temporary, "source");
  const installRoot = path.join(temporary, "install root");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await createSource(source, "1.0.0");
  const lockV1 = await createLock(root, source, "1.0.0");
  t.after(() => rm(temporary, { recursive: true, force: true }));

  const common = ["-InstallRoot", installRoot];
  const dryRun = runSetup(["-SourcePath", source, "-LockPath", lockV1, "-DryRun", ...common]);
  assert.match(dryRun.stdout, /\[DRY RUN\]/);
  await assert.rejects(stat(path.join(installRoot, "state", "current.json")));

  runSetup(["-SourcePath", source, "-LockPath", lockV1, ...common]);
  const currentPath = path.join(installRoot, "state", "current.json");
  const currentV1 = await readJson(currentPath);
  assert.equal(currentV1.version, "1.0.0");
  assert.equal((await readFile(path.join(currentV1.path, "runtime", "kernel.mjs"), "utf8")).includes("1.0.0"), true);

  assert.equal(currentV1.nodeMinimumVersion, "24.15.0");
  const installedV1 = await readInstallState(installRoot);
  assert.equal(installedV1.version, "1.0.0");
  assert.equal(installedV1.fingerprint, currentV1.fingerprint);
  assert.equal(installedV1.payloadRoot.toLowerCase(), (await realpath(currentV1.path)).toLowerCase());

  const firstMtime = (await stat(currentPath)).mtimeMs;
  runSetup(["-SourcePath", source, "-LockPath", lockV1, ...common]);
  assert.equal((await stat(currentPath)).mtimeMs, firstMtime, "idempotent install must not rewrite current.json");

  await writeFile(path.join(source, "runtime", "kernel.mjs"), "fixture 2.0.0: upgraded kernel\n");
  const lockV2 = await createLock(root, source, "2.0.0");
  runSetup(["-SourcePath", source, "-LockPath", lockV2, ...common]);
  assert.equal((await readJson(currentPath)).version, "2.0.0");
  assert.equal((await readJson(path.join(installRoot, "state", "previous.json"))).version, "1.0.0");
  assert.equal((await readInstallState(installRoot)).version, "2.0.0");

  const doctor = runSetup(["-Doctor", ...common]);
  assert.equal(JSON.parse(doctor.stdout).ok, true);
  runSetup(["-Rollback", ...common]);
  assert.equal((await readJson(currentPath)).version, "1.0.0");
  assert.equal((await readJson(path.join(installRoot, "state", "previous.json"))).version, "2.0.0");

  const unrelated = path.join(installRoot, "payloads", "unrelated", "keep.txt");
  await mkdir(path.dirname(unrelated), { recursive: true });
  await writeFile(unrelated, "keep");
  runSetup(["-Uninstall", ...common]);
  await assert.rejects(stat(currentPath));
  await assert.rejects(stat(currentV1.path));
  assert.equal(await readFile(unrelated, "utf8"), "keep");
});

test("repairs a damaged current payload instead of failing reinstallation", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `kimi-cu-repair-${process.pid}-`));
  const source = path.join(root, "source");
  const installRoot = path.join(root, "install");
  await createSource(source, "1.0.0");
  const lock = await createLock(root, source, "1.0.0");
  t.after(() => rm(root, { recursive: true, force: true }));

  runSetup(["-SourcePath", source, "-LockPath", lock, "-InstallRoot", installRoot]);
  const currentPath = path.join(installRoot, "state", "current.json");
  const current = await readJson(currentPath);
  const kernel = path.join(current.path, "runtime", "kernel.mjs");
  await writeFile(kernel, "tampered\n");

  runSetup(["-SourcePath", source, "-LockPath", lock, "-InstallRoot", installRoot]);
  assert.equal((await readFile(kernel, "utf8")).includes("1.0.0"), true);
  assert.equal((await readJson(currentPath)).fingerprint, current.fingerprint);
  assert.equal((await readInstallState(installRoot)).version, "1.0.0");
  await assert.rejects(stat(path.join(installRoot, "state", "previous.json")));
  const payloadDirectories = await readdir(path.join(installRoot, "payloads"));
  assert.equal(payloadDirectories.some((name) => name.includes(".damaged-")), false);
});

test("hash mismatches and unexpected source files fail without writing state", {
  skip: process.platform !== "win32",
  timeout: 60_000,
}, async (t) => {
  const root = await mkdir(path.join(os.tmpdir(), `kimi-cu-reject-${process.pid}-${Date.now()}`), { recursive: true });
  const source = path.join(root, "source");
  const installRoot = path.join(root, "install");
  await createSource(source, "1.0.0");
  const lock = await createLock(root, source, "1.0.0");
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(source, "runtime", "kernel.mjs"), "tampered\n");
  const mismatch = runSetup(["-SourcePath", source, "-LockPath", lock, "-InstallRoot", installRoot], 1);
  assert.match(mismatch.stderr, /size mismatch|SHA-256 mismatch/);

  await createSource(source, "1.0.0");
  await writeFile(path.join(source, "unexpected.txt"), "not locked");
  const extra = runSetup(["-SourcePath", source, "-LockPath", lock, "-InstallRoot", installRoot], 1);
  assert.match(extra.stderr, /not present in the lock/);
  await assert.rejects(stat(path.join(installRoot, "state", "current.json")));
});
