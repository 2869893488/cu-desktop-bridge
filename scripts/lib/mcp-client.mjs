import { spawn } from "node:child_process";

function positiveTimeout(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number.`);
  }
  return value;
}

/** A newline-delimited JSON-RPC client for a stdio MCP child process. */
export class McpClient {
  constructor(executablePath, cwd, {
    args = [],
    requestTimeoutMs = 15_000,
    closeTimeoutMs = 3_000,
  } = {}) {
    this.requestTimeoutMs = positiveTimeout(requestTimeoutMs, "requestTimeoutMs");
    this.closeTimeoutMs = positiveTimeout(closeTimeoutMs, "closeTimeoutMs");
    this.process = spawn(executablePath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.buffer = "";
    this.pendingRequests = new Map();
    this.nextId = 1;
    this.processError = null;
    this.exitInfo = null;
    this.closePromise = null;

    this.process.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.processBuffer();
    });

    this.process.stderr.on("data", (chunk) => {
      const err = chunk.toString("utf8").trim();
      if (err && !err.includes("ExperimentalWarning: VM Modules")) {
        console.warn(`  [SERVER STDERR] ${err}`);
      }
    });

    this.process.on("error", (error) => {
      this.processError = error;
      this.rejectPending(error);
    });
    // Always observe stdin errors so EPIPE cannot become an uncaught exception.
    this.process.stdin.on("error", (error) => {
      this.processError ??= error;
      this.rejectPending(error);
    });

    // 'close' is emitted even when spawning fails; 'exit' is not guaranteed.
    this.closed = new Promise((resolve) => {
      this.process.once("close", (code, signal) => {
        this.exitInfo = { code, signal };
        if (this.pendingRequests.size > 0) {
          const detail = signal ? `signal ${signal}` : `code ${code}`;
          this.rejectPending(new Error(`MCP server exited with ${detail}.`));
        }
        resolve(code);
      });
    });
  }

  settleRequest(id, error, result) {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  rejectPending(error) {
    for (const id of this.pendingRequests.keys()) {
      this.settleRequest(id, error);
    }
  }

  processBuffer() {
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;

      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && this.pendingRequests.has(message.id)) {
          if (message.error) {
            this.settleRequest(
              message.id,
              new Error(`MCP Error ${message.error.code}: ${message.error.message}`),
            );
          } else {
            this.settleRequest(message.id, null, message.result);
          }
        }
      } catch (error) {
        console.error(`  [PARSE ERROR] Failed to parse line: ${line}`, error);
      }
    }
  }

  sendRequest(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    positiveTimeout(timeoutMs, "timeoutMs");
    if (this.processError) return Promise.reject(this.processError);
    if (this.exitInfo) {
      return Promise.reject(new Error(`MCP server has already exited with code ${this.exitInfo.code}.`));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleRequest(
          id,
          new Error(`MCP request '${method}' (id ${id}) timed out after ${timeoutMs} ms.`),
        );
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.process.stdin.write(payload, (error) => {
        if (error) this.settleRequest(id, error);
      });
    });
  }

  sendNotification(method, params = {}) {
    if (this.processError) return Promise.reject(this.processError);
    if (this.exitInfo) return Promise.reject(new Error("MCP server has already exited."));
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.process.stdin.write(payload, (error) => error ? reject(error) : resolve());
    });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (this.exitInfo) return this.exitInfo.code;
      this.process.stdin.end();
      const killer = setTimeout(() => this.process.kill(), this.closeTimeoutMs);
      try {
        return await this.closed;
      } finally {
        clearTimeout(killer);
      }
    })();
    return this.closePromise;
  }
}
