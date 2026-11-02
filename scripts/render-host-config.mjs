#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderHostConfig, supportedHosts } from "./lib/host-config.mjs";

function usage() {
  return `Usage: node scripts/render-host-config.mjs --host <${supportedHosts.join("|")}> [--repo-root <absolute-path>]\n`;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(usage());
  process.exit(0);
}

let host;
let repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  const value = args[index + 1];
  if ((name === "--host" || name === "--repo-root") && !value) {
    process.stderr.write(`${name} requires a value.\n${usage()}`);
    process.exit(2);
  }
  if (name === "--host") host = value;
  else if (name === "--repo-root") repoRoot = value;
  else {
    process.stderr.write(`Unknown argument: ${name}\n${usage()}`);
    process.exit(2);
  }
  index++;
}

if (!host) {
  process.stderr.write(usage());
  process.exit(2);
}

try {
  const output = await renderHostConfig(host, repoRoot);
  process.stderr.write(
    "Note: this renders a development configuration pointing at the repository src/runtime. " +
      "Use scripts/apply-host-config.mjs --install-root for installed payloads.\n",
  );
  process.stdout.write(output);
} catch (error) {
  process.stderr.write(`Failed to render host configuration: ${error.message}\n`);
  process.exitCode = 1;
}
