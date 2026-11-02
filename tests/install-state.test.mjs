import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computeFingerprint, readInstallState } from "../scripts/lib/install-state.mjs";
import { createInstalledPayload } from "./fixtures/install-root.mjs";

async function createRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kimi-cu-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function readStateFile(installRoot) {
  return JSON.parse(await readFile(path.join(installRoot, "state", "current.json"), "utf8"));
}

async function writeStateFile(installRoot, state) {
  await writeFile(path.join(installRoot, "state", "current.json"), JSON.stringify(state, null, 2));
}

test("reads a verified installation state and locates the runtime", async (t) => {
  const root = await createRoot(t);
  const fixture = await createInstalledPayload(root);

  const state = await readInstallState(root);
  assert.equal(state.version, "9.9.9");
  assert.equal(state.fingerprint, fixture.state.fingerprint);
  const canonicalRoot = await realpath(fixture.payloadRoot);
  assert.equal(state.payloadRoot, canonicalRoot);
  assert.equal(state.runtimePath, path.join(canonicalRoot, "runtime", "node-repl.exe"));
  assert.equal(state.files.length, 4);
});

test("fails closed when the state file is missing or unreadable", async (t) => {
  const root = await createRoot(t);
  await assert.rejects(readInstallState(root), /No installed payload found/);

  const fixture = await createInstalledPayload(root);
  await writeFile(fixture.statePath, "{ not json");
  await assert.rejects(readInstallState(root), /not valid JSON/);
});

test("rejects unknown schemas, unsafe paths and malformed entries", async (t) => {
  const root = await createRoot(t);
  const fixture = await createInstalledPayload(root);
  const original = await readStateFile(root);

  await writeStateFile(root, { ...original, schemaVersion: 2 });
  await assert.rejects(readInstallState(root), /schemaVersion/);

  await writeStateFile(root, {
    ...original,
    files: [...original.files, { path: "../outside.txt", size: 1, sha256: "0".repeat(64) }],
  });
  await assert.rejects(readInstallState(root), /unsafe file path/);

  await writeStateFile(root, {
    ...original,
    files: [...original.files, { path: "C:/absolute.txt", size: 1, sha256: "0".repeat(64) }],
  });
  await assert.rejects(readInstallState(root), /absolute file path/);

  await writeStateFile(root, { ...original, files: [...original.files, original.files[0]] });
  await assert.rejects(readInstallState(root), /duplicate file/);
});

test("rejects payloads outside the managed directory", async (t) => {
  const root = await createRoot(t);
  const original = await createInstalledPayload(root);
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });

  const state = await readStateFile(root);
  await writeStateFile(root, { ...state, path: outside });
  await assert.rejects(readInstallState(root), /outside the managed payloads directory/);
  assert.ok(original.payloadRoot.startsWith(path.join(root, "payloads")));
});

test("detects missing files, size mismatches and hash mismatches", async (t) => {
  const root = await createRoot(t);
  const fixture = await createInstalledPayload(root);
  const kernel = path.join(fixture.payloadRoot, "runtime", "kernel.mjs");

  await writeFile(kernel, "export const kernel = 22;\n");
  await assert.rejects(readInstallState(root), /size mismatch/);

  await writeFile(kernel, "export const kernel = 1;\n".replace("1", "3"));
  await assert.rejects(readInstallState(root), /SHA-256 mismatch/);

  await unlink(path.join(fixture.payloadRoot, "bin", "launch.mjs"));
  await assert.rejects(readInstallState(root), /missing/);
});

test("requires the runtime binary to be part of the verified file list", async (t) => {
  const root = await createRoot(t);
  await createInstalledPayload(root);
  const state = await readStateFile(root);
  const files = state.files.filter((entry) => entry.path !== "runtime/node-repl.exe");
  await writeStateFile(root, {
    ...state,
    files,
    fingerprint: computeFingerprint(state.name, state.version, files),
  });
  await assert.rejects(readInstallState(root), /does not include runtime\/node-repl\.exe/);
});

test("rejects a state whose fingerprint does not match its file list", async (t) => {
  const root = await createRoot(t);
  await createInstalledPayload(root);
  const state = await readStateFile(root);
  await writeStateFile(root, { ...state, fingerprint: "a".repeat(64) });
  await assert.rejects(readInstallState(root), /fingerprint does not match/);
});

test("rejects symbolic links inside the installed payload", async (t) => {
  const root = await createRoot(t);
  const fixture = await createInstalledPayload(root);
  const link = path.join(fixture.payloadRoot, "runtime", "linked.mjs");
  try {
    await symlink(path.join(fixture.payloadRoot, "runtime", "kernel.mjs"), link);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("Symbolic link creation is not permitted for this user.");
      return;
    }
    throw error;
  }

  const bytes = await readFile(path.join(fixture.payloadRoot, "runtime", "kernel.mjs"));
  const state = await readStateFile(root);
  state.files.push({
    path: "runtime/linked.mjs",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  state.fingerprint = computeFingerprint(state.name, state.version, state.files);
  await writeStateFile(root, state);
  await assert.rejects(readInstallState(root), /symbolic link or reparse point/);
});
