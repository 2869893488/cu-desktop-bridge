import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const STATE_SCHEMA_VERSION = 1;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const RUNTIME_RELATIVE_PATH = `runtime/node-repl.exe`;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizePayloadPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Every installation state file entry must have a non-empty path.");
  }
  const normalized = value.replaceAll("\\", "/");
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("/")) {
    throw new Error(`Installation state contains an absolute file path: ${value}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Installation state contains an unsafe file path: ${value}`);
  }
  return normalized;
}

function isPathInside(candidate, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function computeFingerprint(name, version, files) {
  const sorted = [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const input = [name, version, ...sorted.map((file) => `${file.path}\0${file.size}\0${file.sha256}`)].join("\n");
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function parseState(text, statePath) {
  let state;
  try {
    state = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Installation state is not valid JSON: ${statePath}`);
  }
  if (!isPlainObject(state)) {
    throw new Error(`Installation state must be a JSON object: ${statePath}`);
  }
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported installation state schemaVersion ${state.schemaVersion}; expected ${STATE_SCHEMA_VERSION}.`);
  }
  if (typeof state.name !== "string" || !IDENTIFIER.test(state.name)) {
    throw new Error("Installation state has an invalid payload name.");
  }
  if (typeof state.version !== "string" || !IDENTIFIER.test(state.version)) {
    throw new Error("Installation state has an invalid payload version.");
  }
  if (typeof state.fingerprint !== "string" || !SHA256_HEX.test(state.fingerprint)) {
    throw new Error("Installation state has an invalid payload fingerprint.");
  }
  if (typeof state.path !== "string" || !path.isAbsolute(state.path)) {
    throw new Error("Installation state does not contain an absolute payload path.");
  }
  if (!Array.isArray(state.files) || state.files.length === 0) {
    throw new Error("Installation state does not list any payload files.");
  }

  const seen = new Set();
  const files = state.files.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new Error("Installation state contains a malformed file entry.");
    }
    const relativePath = normalizePayloadPath(entry.path);
    if (seen.has(relativePath.toLowerCase())) {
      throw new Error(`Installation state lists a duplicate file: ${relativePath}`);
    }
    seen.add(relativePath.toLowerCase());
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`Installation state has an invalid size for ${relativePath}.`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) {
      throw new Error(`Installation state has an invalid SHA-256 for ${relativePath}.`);
    }
    return { path: relativePath, size: entry.size, sha256: entry.sha256 };
  });

  return { ...state, files };
}

async function assertFileMatches(entry, payloadRoot, realPayloadRoot) {
  const target = path.join(payloadRoot, ...entry.path.split("/"));
  if (!isPathInside(target, payloadRoot)) {
    throw new Error(`Installation state path escapes the payload directory: ${entry.path}`);
  }
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Installed payload file is missing: ${entry.path}. Reinstall the payload.`);
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Installed payload file is a symbolic link or reparse point: ${entry.path}`);
  }
  if (!info.isFile()) {
    throw new Error(`Installed payload entry is not a regular file: ${entry.path}`);
  }
  if (info.size !== entry.size) {
    throw new Error(`Installed payload size mismatch for ${entry.path}: expected ${entry.size}, found ${info.size}.`);
  }
  const resolved = await realpath(target);
  if (!isPathInside(resolved, realPayloadRoot)) {
    throw new Error(`Installed payload file resolves outside the payload directory: ${entry.path}`);
  }
  const actual = createHash("sha256").update(await readFile(target)).digest("hex");
  if (actual !== entry.sha256) {
    throw new Error(`Installed payload SHA-256 mismatch for ${entry.path}. Reinstall the payload.`);
  }
}

export async function readInstallState(installRoot) {
  if (typeof installRoot !== "string" || !path.isAbsolute(installRoot)) {
    throw new Error("The installation root must be an absolute path.");
  }
  const root = path.resolve(installRoot);
  const statePath = path.join(root, "state", "current.json");
  let text;
  try {
    text = await readFile(statePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`No installed payload found. Expected ${statePath}. Run scripts/setup.ps1 first.`);
    }
    throw error;
  }

  const state = parseState(text, statePath);
  if (!state.files.some((entry) => entry.path.toLowerCase() === RUNTIME_RELATIVE_PATH)) {
    throw new Error(`Installation state does not include ${RUNTIME_RELATIVE_PATH}; refusing to launch an unverified runtime.`);
  }

  const payloadsRoot = path.join(root, "payloads");
  let realPayloadsRoot;
  let realPayloadRoot;
  try {
    realPayloadsRoot = await realpath(payloadsRoot);
    realPayloadRoot = await realpath(state.path);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Installation state points to a payload that no longer exists: ${state.path}`);
    }
    throw error;
  }
  if (!isPathInside(realPayloadRoot, realPayloadsRoot)) {
    throw new Error(`Installation state points outside the managed payloads directory: ${state.path}`);
  }

  for (const entry of state.files) {
    await assertFileMatches(entry, realPayloadRoot, realPayloadsRoot);
  }

  const fingerprint = computeFingerprint(state.name, state.version, state.files);
  if (fingerprint !== state.fingerprint) {
    throw new Error(
      `Installation state fingerprint does not match its file list. Reinstall the payload instead of editing state by hand.`,
    );
  }

  const runtimePath = path.join(realPayloadRoot, ...RUNTIME_RELATIVE_PATH.split("/"));
  const runtimeInfo = await lstat(runtimePath).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(`Installed payload does not contain ${RUNTIME_RELATIVE_PATH}.`);
    }
    throw error;
  });
  if (runtimeInfo.isSymbolicLink() || !runtimeInfo.isFile()) {
    throw new Error(`Installed runtime entry is not a regular file: ${RUNTIME_RELATIVE_PATH}`);
  }

  return {
    installRoot: root,
    statePath,
    name: state.name,
    version: state.version,
    fingerprint: state.fingerprint,
    payloadRoot: realPayloadRoot,
    runtimePath,
    files: state.files,
    installedAtUtc: typeof state.installedAtUtc === "string" ? state.installedAtUtc : null,
  };
}
