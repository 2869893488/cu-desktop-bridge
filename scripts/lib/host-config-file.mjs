import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { SERVER_KEY } from "./host-config.mjs";

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const RETRYABLE_RENAME_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_DELAYS_MS = [0, 20, 50, 100, 200];
let temporarySequence = 0;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detectIndent(text) {
  const match = text.match(/^([ \t]+)\S/m);
  if (!match) return "  ";
  return match[1].length <= 10 ? match[1] : "  ";
}

export async function readHostConfig(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("The host configuration path must be an absolute path.");
  }

  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, config: {}, indent: "  ", newline: "\n" };
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to modify a symbolic link: ${filePath}`);
  }
  if (!info.isFile()) {
    throw new Error(`Host configuration is not a regular file: ${filePath}`);
  }
  if (info.size > MAX_CONFIG_BYTES) {
    throw new Error(`Host configuration is larger than ${MAX_CONFIG_BYTES} bytes; refusing to rewrite it.`);
  }

  const text = (await readFile(filePath)).toString("utf8").replace(/^\uFEFF/, "");
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    // Do not echo parser output: it can quote a prefix of the file contents.
    throw new Error(`Refusing to overwrite ${filePath}: the existing file is not valid JSON.`);
  }
  if (!isPlainObject(config)) {
    throw new Error(`Refusing to overwrite ${filePath}: the top-level JSON value must be an object.`);
  }
  if (config.mcpServers !== undefined && !isPlainObject(config.mcpServers)) {
    throw new Error(`Refusing to overwrite ${filePath}: mcpServers must be a JSON object.`);
  }
  return {
    exists: true,
    config,
    indent: detectIndent(text),
    newline: text.includes("\r\n") ? "\r\n" : "\n",
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

export async function assertConfigUnchanged(filePath, snapshot) {
  if (!snapshot?.exists) return;
  let latest;
  try {
    latest = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Host configuration disappeared while preparing the update: ${filePath}`);
    }
    throw error;
  }
  if (latest.size !== snapshot.size || latest.mtimeMs !== snapshot.mtimeMs) {
    throw new Error(`Host configuration changed on disk while preparing the update: ${filePath}. Close the host and retry.`);
  }
}

export function mergeManagedServer(config, entry) {
  const servers = isPlainObject(config.mcpServers) ? config.mcpServers : {};
  return { ...config, mcpServers: { ...servers, [SERVER_KEY]: entry } };
}

export function removeManagedServer(config) {
  if (!isPlainObject(config.mcpServers) || !Object.hasOwn(config.mcpServers, SERVER_KEY)) {
    return { config, changed: false };
  }
  const servers = { ...config.mcpServers };
  delete servers[SERVER_KEY];
  return { config: { ...config, mcpServers: servers }, changed: true };
}

export function isDeepEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => isDeepEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && isDeepEqual(left[key], right[key]))
    );
  }
  return false;
}

export function serializeHostConfig(config, formatting = {}) {
  const indent = formatting.indent ?? "  ";
  const newline = formatting.newline ?? "\n";
  return JSON.stringify(config, null, indent).replaceAll("\n", newline) + newline;
}

export async function replaceWithRetry(temporary, destination, options = {}) {
  const renameFile = options.renameFile ?? rename;
  const delays = options.delays ?? RENAME_RETRY_DELAYS_MS;
  let lastError;
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await renameFile(temporary, destination);
      return;
    } catch (error) {
      if (!RETRYABLE_RENAME_ERRORS.has(error.code)) throw error;
      lastError = error;
    }
  }
  throw new Error(
    `Could not replace ${destination} because it is locked (${lastError?.code}). ` +
      "Close the host application or any editor using this file, then retry.",
  );
}

async function assertParentDirectory(filePath) {
  const directory = path.dirname(filePath);
  const parent = await stat(directory).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(`Host configuration directory does not exist: ${directory}. Start or install the host first.`);
    }
    throw error;
  });
  if (!parent.isDirectory()) {
    throw new Error(`Host configuration parent is not a directory: ${directory}`);
  }
}

export async function writeHostConfigAtomic(filePath, config, formatting = {}) {
  const directory = path.dirname(filePath);
  await assertParentDirectory(filePath);

  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.kimi-cu-${process.pid}-${++temporarySequence}.tmp`,
  );
  let replaced = false;
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(serializeHostConfig(config, formatting), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceWithRetry(temporary, filePath);
    replaced = true;
  } catch (error) {
    throw new Error(`Could not atomically write ${filePath}: ${error.message}`);
  } finally {
    if (!replaced) await unlink(temporary).catch(() => {});
  }
}

function formatTimestamp(now) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function backupHostConfig(filePath, options = {}) {
  const stamp = formatTimestamp(options.now ?? new Date());
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  for (let attempt = 1; attempt <= 100; attempt++) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const backupPath = path.join(directory, `${baseName}.kimi-cu-backup-${stamp}${suffix}`);
    try {
      await copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL);
      return backupPath;
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw new Error(`Could not back up ${filePath}: ${error.message}`);
    }
  }
  throw new Error(`Could not create a unique backup file for ${filePath}.`);
}

export async function applyHostConfig({ configPath, entry, remove = false, dryRun = false, now }) {
  const current = await readHostConfig(configPath);

  if (remove) {
    if (!current.exists) {
      return { action: "missing", configPath, backupPath: null };
    }
    const result = removeManagedServer(current.config);
    if (!result.changed) {
      return { action: "unchanged", configPath, backupPath: null };
    }
    if (dryRun) {
      return { action: "would-remove", configPath, backupPath: null };
    }
    const backupPath = await backupHostConfig(configPath, { now });
    await assertConfigUnchanged(configPath, current);
    await writeHostConfigAtomic(configPath, result.config, current);
    return { action: "removed", configPath, backupPath };
  }

  if (!current.exists) await assertParentDirectory(configPath);

  const servers = isPlainObject(current.config.mcpServers) ? current.config.mcpServers : {};
  if (current.exists && isDeepEqual(servers[SERVER_KEY], entry)) {
    return { action: "unchanged", configPath, backupPath: null };
  }
  if (dryRun) {
    return { action: current.exists ? "would-update" : "would-create", configPath, backupPath: null };
  }

  const backupPath = current.exists ? await backupHostConfig(configPath, { now }) : null;
  await assertConfigUnchanged(configPath, current);
  await writeHostConfigAtomic(configPath, mergeManagedServer(current.config, entry), current);
  return { action: current.exists ? "updated" : "created", configPath, backupPath };
}
