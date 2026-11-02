import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_KEY = "kimi-cu";
export const ROOT_TOKEN = "__KIMI_CU_ROOT__";
export const RUNTIME_DIR_TOKEN = "__KIMI_CU_RUNTIME_DIR__";

const templateNames = Object.freeze({
  antigravity: "antigravity/mcp_config.json",
  "claude-desktop": "claude-desktop/claude_desktop_config.json",
  codex: "codex/codex_mcp.json",
  workbuddy: "workbuddy/workbuddy_mcp.json",
});

export const supportedHosts = Object.freeze(Object.keys(templateNames));

// Codex stores MCP servers in TOML (config.toml), so the JSON templates for
// that host are reference material only and cannot be merged automatically.
export const jsonConfigHosts = Object.freeze(["antigravity", "claude-desktop", "workbuddy"]);

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function toPortablePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return value.replaceAll("\\", "/");
}

function buildPathEnvironment() {
  const directories = [path.dirname(process.execPath)];
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (systemRoot) {
    directories.push(path.join(systemRoot, "System32"), systemRoot, path.join(systemRoot, "System32", "Wbem"));
  }
  const seen = new Set();
  return directories
    .filter((directory) => {
      const key = directory.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((directory) => directory.replaceAll("\\", "/"))
    .join(";");
}

function replaceTokens(value, root, runtimeDir) {
  if (typeof value === "string") {
    // Function replacers keep "$&" and "$'" in Windows paths literal.
    return value.replaceAll(ROOT_TOKEN, () => root).replaceAll(RUNTIME_DIR_TOKEN, () => runtimeDir);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceTokens(item, root, runtimeDir));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceTokens(item, root, runtimeDir)]),
    );
  }
  return value;
}

export async function buildHostConfig(host, options = {}) {
  const templateName = templateNames[host];
  if (!templateName) {
    throw new Error(`Unsupported host '${host}'. Choose one of: ${supportedHosts.join(", ")}.`);
  }

  const root = options.root ?? defaultRepoRoot;
  const runtimeDir = options.runtimeDir ?? path.join(root, "src", "runtime");
  const portableRoot = toPortablePath(root, "The host configuration root");
  const portableRuntimeDir = toPortablePath(runtimeDir, "The runtime directory");

  const templatePath = path.join(defaultRepoRoot, "templates", templateName);
  const source = await readFile(templatePath, "utf8");
  let template;
  try {
    template = JSON.parse(source);
  } catch (error) {
    throw new Error(`Template '${templateName}' is not valid JSON: ${error.message}`);
  }

  const config = replaceTokens(template, portableRoot, portableRuntimeDir);
  const server = config?.mcpServers?.[SERVER_KEY];
  if (server && typeof server === "object" && server.env && typeof server.env === "object" && Object.hasOwn(server.env, "PATH")) {
    // Hosts do not expand "%PATH%": build a minimal PATH without leaking the full user PATH.
    server.env.PATH = buildPathEnvironment();
  }
  if (!server || typeof server !== "object") {
    throw new Error(`Template '${templateName}' has no mcpServers.${SERVER_KEY} entry.`);
  }
  if (server.cwd !== portableRoot) {
    throw new Error(`Template '${templateName}' has an invalid MCP working directory.`);
  }
  if (server.command !== `${portableRuntimeDir}/node-repl.exe`) {
    throw new Error(`Template '${templateName}' has an invalid MCP command.`);
  }
  return config;
}

export async function renderHostConfig(host, repoRoot = defaultRepoRoot, options = {}) {
  const config = await buildHostConfig(host, { root: repoRoot, runtimeDir: options.runtimeDir });
  return `${JSON.stringify(config, null, 2)}\n`;
}
