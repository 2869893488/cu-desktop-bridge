#!/usr/bin/env node
import path from "node:path";
import { applyHostConfig } from "./lib/host-config-file.mjs";
import { SERVER_KEY, buildHostConfig, jsonConfigHosts, supportedHosts } from "./lib/host-config.mjs";
import { readInstallState } from "./lib/install-state.mjs";

function usage() {
  return [
    "Usage: node scripts/apply-host-config.mjs --host <" + supportedHosts.join("|") + ">",
    "       --config-path <absolute-path>",
    "       (--install-root <absolute-path> | --repo-root <absolute-path>)  # required unless --remove",
    "       [--dry-run] [--remove] [--json]",
    "",
    "  --config-path   Existing host configuration file to merge into.",
    "  --install-root  Use the verified payload recorded in <root>/state/current.json.",
    "  --repo-root     Development only: point the host at this repository's src/runtime.",
    "  --remove        Remove only mcpServers." + SERVER_KEY + " and leave other servers untouched.",
    "  --dry-run       Verify everything and report the planned action without writing.",
    "  --json          Print a machine-readable summary.",
  ].join("\n") + "\n";
}

function isPathInside(candidate, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function quotePowerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function fail(message, code = 2) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(usage());
  process.exit(0);
}

const valueFlags = new Set(["--host", "--config-path", "--install-root", "--repo-root"]);
const booleanFlags = new Set(["--dry-run", "--remove", "--json"]);
const options = { dryRun: false, remove: false, json: false };

for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (valueFlags.has(name)) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`${name} requires a value.\n${usage()}`);
    options[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index++;
  } else if (booleanFlags.has(name)) {
    options[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
  } else {
    fail(`Unknown argument: ${name}\n${usage()}`);
  }
}

if (!options.host) fail(usage());
if (!supportedHosts.includes(options.host)) {
  fail(`Unsupported host '${options.host}'. Choose one of: ${supportedHosts.join(", ")}.`);
}
if (!jsonConfigHosts.includes(options.host)) {
  fail(
    `${options.host} stores MCP servers in TOML, so it cannot be merged as JSON. \n` +
      "Add the server table manually; see docs/HOST_INTEGRATION_GUIDE.md. No files were changed.",
  );
}
if (!options.configPath) fail(usage());
if (!path.isAbsolute(options.configPath)) fail("--config-path must be an absolute path.");
const normalizedConfigPath = path.resolve(options.configPath).replaceAll("\\", "/").toLowerCase();
if (/(^|\/)\.kimi-code\/plugins\/managed\//.test(normalizedConfigPath)) {
  fail("Refusing to write inside the official Kimi Code managed plugin directory. No files were changed.");
}
if (options.remove) {
  if (options.installRoot && options.repoRoot) {
    fail("Pass at most one of --install-root or --repo-root.");
  }
} else if (Boolean(options.installRoot) === Boolean(options.repoRoot)) {
  fail("Pass exactly one of --install-root or --repo-root.");
}

let entry = null;
let source = null;
try {
  if (!options.remove && options.installRoot) {
    if (!path.isAbsolute(options.installRoot)) fail("--install-root must be an absolute path.");
    const state = await readInstallState(options.installRoot);
    const config = await buildHostConfig(options.host, {
      root: state.payloadRoot,
      runtimeDir: path.dirname(state.runtimePath),
    });
    entry = config.mcpServers[SERVER_KEY];
    source = {
      mode: "installed",
      name: state.name,
      version: state.version,
      fingerprint: state.fingerprint,
      payloadRoot: state.payloadRoot,
    };
    const resolvedConfigPath = path.resolve(options.configPath);
    if (isPathInside(resolvedConfigPath, state.installRoot) || isPathInside(resolvedConfigPath, state.payloadRoot)) {
      fail("Refusing to write inside the installation or payload directory. No files were changed.");
    }
  } else if (!options.remove) {
    if (!path.isAbsolute(options.repoRoot)) fail("--repo-root must be an absolute path.");
    const root = path.resolve(options.repoRoot);
    const config = await buildHostConfig(options.host, { root });
    entry = config.mcpServers[SERVER_KEY];
    source = { mode: "repository", root };
  }

  const result = await applyHostConfig({
    configPath: path.resolve(options.configPath),
    entry,
    remove: options.remove,
    dryRun: options.dryRun,
  });

  const restoreCommand = result.backupPath
    ? `Copy-Item -LiteralPath ${quotePowerShellLiteral(result.backupPath)} -Destination ${quotePowerShellLiteral(result.configPath)} -Force`
    : null;
  const summary = {
    ok: true,
    host: options.host,
    configPath: result.configPath,
    action: result.action,
    backupPath: result.backupPath,
    restoreCommand,
    source,
    server: entry ? { command: entry.command, cwd: entry.cwd } : null,
    dryRun: options.dryRun,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    const lines = [];
    if (source) {
      lines.push(
        `Source: ${source.mode === "installed"
          ? `installed payload ${source.name} ${source.version} (fingerprint ${source.fingerprint})`
          : `repository ${source.root}`}`,
      );
    }
    lines.push(`Host: ${options.host}`, `Config: ${result.configPath}`);
    if (entry) {
      lines.push(`Command: ${entry.command}`, `Working directory: ${entry.cwd}`);
    }
    lines.push(`Action: ${result.action}${options.dryRun ? " (dry run, no files changed)" : ""}`);
    if (result.backupPath) {
      lines.push(`Backup: ${result.backupPath}`);
      lines.push(`Restore: ${restoreCommand}`);
    }
    if (source?.mode === "repository") {
      lines.push("Warning: repository mode is for development only. Use --install-root for installed payloads.");
    }
    process.stdout.write(lines.join("\n") + "\n");
  }
} catch (error) {
  process.stderr.write(`Failed to apply host configuration: ${error.message}\n`);
  process.exitCode = 1;
}
