import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(repoRoot, relative), "utf8");

test("npm test is hermetic and live desktop testing is opt-in", async () => {
  const manifest = JSON.parse(await read("package.json"));
  assert.equal(manifest.private, true);
  assert.match(manifest.scripts.test, /node --test/);
  assert.doesNotMatch(manifest.scripts.test, /test-mcp-smoke/);
  if (manifest.scripts.smoke) {
    assert.match(manifest.scripts.smoke, /test-mcp-smoke/);
  }
});

test("user-facing templates and guides contain no developer machine paths", async () => {
  const files = [
    "README.md",
    "docs/HOST_INTEGRATION_GUIDE.md",
    "templates/antigravity/README.md",
    "templates/claude-desktop/README.md",
    "templates/codex/README.md",
    "templates/workbuddy/README.md",
    "templates/antigravity/mcp_config.json",
    "templates/claude-desktop/claude_desktop_config.json",
    "templates/codex/codex_mcp.json",
    "templates/workbuddy/workbuddy_mcp.json",
  ];
  for (const file of files) {
    const contents = await read(file);
    assert.doesNotMatch(contents, /(?:C:[\\/]+Users[\\/]+[^\s"']+[\\/]+AppData|\.gemini[\\/]+antigravity[\\/]+scratch)/i, file);
  }
});
