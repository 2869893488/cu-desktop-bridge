import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeFingerprint } from "../../scripts/lib/install-state.mjs";

const defaultFiles = {
  "bin/launch.mjs": "export const launch = 1;\n",
  "runtime/kernel.mjs": "export const kernel = 1;\n",
  "runtime/node-repl.exe": "fixture runtime\n",
  "skills/kimi-cu/SKILL.md": "# fixture\n",
};

export async function createInstalledPayload(installRoot, options = {}) {
  const name = options.name ?? "kimi-cu-fixture";
  const version = options.version ?? "9.9.9";
  const files = options.files ?? defaultFiles;
  const payloadRoot = path.join(installRoot, "payloads", `${name}-${version}-fixture`);
  const entries = [];

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(payloadRoot, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
    const bytes = Buffer.from(contents);
    entries.push({ path: relative, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }

  const statePath = path.join(installRoot, "state", "current.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  const state = {
    schemaVersion: 1,
    name,
    version,
    fingerprint: computeFingerprint(name, version, entries),
    path: payloadRoot,
    files: entries,
    installedAtUtc: "2026-11-02T00:00:00.0000000Z",
  };
  await writeFile(statePath, JSON.stringify(state, null, 2));
  return { installRoot, payloadRoot, statePath, state };
}
