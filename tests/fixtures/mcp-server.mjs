const keepOpenAfterEof = process.argv.includes("--keep-open-after-eof");
let buffer = "";

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request) {
  if (request.id === undefined) return;
  if (request.method === "test/exit") process.exit(7);
  if (request.method === "test/never-respond") return;
  if (request.method === "test/error") {
    reply({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "fixture failure" } });
    return;
  }
  if (request.method === "test/slow") {
    setTimeout(() => reply({ jsonrpc: "2.0", id: request.id, result: { ok: true } }), 200);
    return;
  }
  reply({ jsonrpc: "2.0", id: request.id, result: { method: request.method, params: request.params } });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  if (!keepOpenAfterEof) process.exit(0);
});
if (keepOpenAfterEof) setInterval(() => {}, 1_000);
