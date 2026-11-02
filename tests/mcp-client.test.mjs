import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { McpClient } from "../scripts/lib/mcp-client.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repoRoot, "tests", "fixtures", "mcp-server.mjs");

function createClient(t, options = {}) {
  const client = new McpClient(process.execPath, repoRoot, {
    args: [fixture, ...(options.keepOpenAfterEof ? ["--keep-open-after-eof"] : [])],
    requestTimeoutMs: options.requestTimeoutMs ?? 500,
    closeTimeoutMs: options.closeTimeoutMs ?? 100,
  });
  t.after(() => client.close());
  return client;
}

test("resolves responses and sends notifications", async (t) => {
  const client = createClient(t);
  const result = await client.sendRequest("test/echo", { value: 42 });
  assert.deepEqual(result, { method: "test/echo", params: { value: 42 } });
  await client.sendNotification("notifications/initialized");
  assert.equal(client.pendingRequests.size, 0);
});

test("surfaces JSON-RPC errors", async (t) => {
  const client = createClient(t);
  await assert.rejects(client.sendRequest("test/error"), /MCP Error -32001: fixture failure/);
  assert.equal(client.pendingRequests.size, 0);
});

test("times out requests and removes their pending entries", async (t) => {
  const client = createClient(t);
  await assert.rejects(
    client.sendRequest("test/never-respond", {}, { timeoutMs: 30 }),
    /test\/never-respond.*timed out after 30 ms/,
  );
  assert.equal(client.pendingRequests.size, 0);
});

test("rejects pending requests when the server exits", async (t) => {
  const client = createClient(t);
  await assert.rejects(client.sendRequest("test/exit"), /exited with code 7/);
  assert.equal(client.pendingRequests.size, 0);
});

test("close terminates a child that ignores stdin EOF", async (t) => {
  const client = createClient(t, { keepOpenAfterEof: true, closeTimeoutMs: 30 });
  await client.sendRequest("test/echo");
  const started = Date.now();
  await client.close();
  assert.ok(Date.now() - started < 2_000, "close should not hang indefinitely");
  assert.notEqual(client.exitInfo, null);
});

test("rejects requests and closes cleanly when the executable is missing", async (t) => {
  const client = new McpClient(path.join(repoRoot, "missing-supervisor.exe"), repoRoot, {
    requestTimeoutMs: 500,
    closeTimeoutMs: 100,
  });
  t.after(() => client.close());
  await assert.rejects(client.sendRequest("initialize"), /ENOENT/);
  await client.close();
  assert.equal(client.pendingRequests.size, 0);
});
