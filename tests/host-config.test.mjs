import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildHostConfig, renderHostConfig, supportedHosts } from "../scripts/lib/host-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("all host templates render absolute paths without developer-specific data", async () => {
  for (const host of supportedHosts) {
    const rendered = await renderHostConfig(host, repoRoot);
    const config = JSON.parse(rendered);
    const server = config.mcpServers["kimi-cu"];
    assert.equal(server.cwd, repoRoot.replaceAll("\\", "/"));
    assert.ok(path.isAbsolute(server.command), `${host} command must be absolute`);
    assert.ok(!rendered.includes("__KIMI_CU_ROOT__"));
    assert.ok(!rendered.includes("__KIMI_CU_RUNTIME_DIR__"));
  }
});

test("rendering preserves spaces and Unicode in repository paths", async () => {
  const root = "C:\\Users\\测试 用户\\Desktop Bridge";
  const rendered = await renderHostConfig("codex", root);
  const server = JSON.parse(rendered).mcpServers["kimi-cu"];
  assert.equal(server.cwd, "C:/Users/测试 用户/Desktop Bridge");
  assert.equal(server.command, "C:/Users/测试 用户/Desktop Bridge/src/runtime/node-repl.exe");
});

test("installed payloads render the payload runtime instead of the repository src tree", async () => {
  const payloadRoot = "C:\\Users\\测试 用户\\AppData\\Local\\KimiCU-Community\\payloads\\kimi-cu-win-9.9.9-abcdef123456";
  const runtimeDir = path.join(payloadRoot, "runtime");
  const config = await buildHostConfig("claude-desktop", { root: payloadRoot, runtimeDir });
  const server = config.mcpServers["kimi-cu"];
  assert.equal(server.cwd, payloadRoot.replaceAll("\\", "/"));
  assert.equal(server.command, `${runtimeDir.replaceAll("\\", "/")}/node-repl.exe`);
  assert.equal(server.command.includes("/src/"), false);
});

test("builds a PATH without placeholders or the full user PATH", async () => {
  const config = await buildHostConfig("codex", { root: repoRoot });
  const env = config.mcpServers["kimi-cu"].env;
  const nodeDirectory = path.dirname(process.execPath).replaceAll("\\", "/");
  assert.equal(env.PATH.includes("%PATH%"), false);
  assert.equal(env.PATH.split(";")[0], nodeDirectory);
  if (process.env.SystemRoot) {
    assert.equal(env.PATH.toLowerCase().includes(process.env.SystemRoot.replaceAll("\\", "/").toLowerCase()), true);
  }
});

test("paths containing replacement patterns are preserved literally", async () => {
  const payloadRoot = "C:\\Users\\$&\\$'\\payload";
  const runtimeDir = path.join(payloadRoot, "runtime");
  const config = await buildHostConfig("workbuddy", { root: payloadRoot, runtimeDir });
  const server = config.mcpServers["kimi-cu"];
  assert.equal(server.cwd, payloadRoot.replaceAll("\\", "/"));
  assert.equal(server.command, `${runtimeDir.replaceAll("\\", "/")}/node-repl.exe`);
});

test("unsupported hosts and relative roots are rejected", async () => {
  await assert.rejects(renderHostConfig("unknown", repoRoot), /Unsupported host/);
  await assert.rejects(renderHostConfig("codex", "relative/path"), /absolute path/);
});
