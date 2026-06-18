import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CLIENT_NAME = "pi-mcporter-bridge";
const SHARED_CONNECT_CEILING_MS = 60_000;

export type DiscoveredTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

// listTools is idempotent and retried once on transport error.
// callTool is not retried; MCP has no idempotency contract.
export class ServerClient {
  private readonly url: URL;
  private readonly clientVersion: string;
  private client: Client | undefined;
  private connectPromise: Promise<Client> | undefined;
  private connectAbort: AbortController | undefined;

  constructor(url: string, clientVersion: string) {
    this.url = new URL(url);
    this.clientVersion = clientVersion;
  }

  async listTools(
    connectTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DiscoveredTool[]> {
    const run = async (client: Client): Promise<DiscoveredTool[]> => {
      const res = await client.listTools(undefined, {
        timeout: connectTimeoutMs,
        signal,
      });
      return res.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
          type: "object",
        },
      }));
    };

    signal?.throwIfAborted();
    const client = await this.connect(connectTimeoutMs, signal);
    try {
      return await run(client);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!isTransportError(err)) throw err;
      await this.close();
      signal?.throwIfAborted();
      const fresh = await this.connect(connectTimeoutMs, signal);
      return await run(fresh);
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    connectTimeoutMs: number,
    callTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    let client = await this.connect(connectTimeoutMs, signal);
    try {
      return await client.callTool({ name, arguments: args }, undefined, {
        timeout: callTimeoutMs,
        signal,
      });
    } catch (initialErr) {
      let err: unknown = initialErr;
      // "Not connected" is thrown before bytes leave the client; safe to retry.
      if (signal?.aborted === false && isNotConnectedError(err)) {
        await this.close();
        signal?.throwIfAborted();
        client = await this.connect(connectTimeoutMs, signal);
        try {
          return await client.callTool({ name, arguments: args }, undefined, {
            timeout: callTimeoutMs,
            signal,
          });
        } catch (retryErr) {
          err = retryErr;
        }
      }
      if (signal?.aborted) throw err;
      const safeName = name.length > 256
        ? `${name.slice(0, 256)}...[+${name.length - 256}]`
        : name;
      if (isTimeoutError(err)) {
        const original = err instanceof Error ? err.message : String(err);
        throw new Error(
          `timeout during ${safeName} (call may have completed server-side): ${original}`,
        );
      }
      if (isTransportError(err)) {
        await this.close();
        const original = err instanceof Error ? err.message : String(err);
        throw new Error(
          `transport error during ${safeName} (call may have completed server-side): ${original}`,
        );
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    const connectAbort = this.connectAbort;
    const connectPromise = this.connectPromise;
    this.client = undefined;
    this.connectPromise = undefined;
    this.connectAbort = undefined;
    if (connectAbort && !connectAbort.signal.aborted) {
      connectAbort.abort();
    }
    if (connectPromise) {
      await connectPromise.catch(() => {});
    }
    if (client) {
      await client.close().catch(() => {});
    }
  }

  private async connect(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connectPromise) {
      this.connectAbort = new AbortController();
      this.connectPromise = this.startConnect(this.connectAbort.signal);
    }
    return await withTimeout(
      this.connectPromise,
      timeoutMs,
      `connect ${this.url.toString()} timed out after ${timeoutMs}ms`,
      signal,
    );
  }

  private async startConnect(abortSignal: AbortSignal): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(this.url);
    const client = new Client({
      name: CLIENT_NAME,
      version: this.clientVersion,
    });
    try {
      await withTimeout(
        client.connect(transport, { signal: abortSignal }),
        SHARED_CONNECT_CEILING_MS,
        `connect ${this.url.toString()} timed out after ${SHARED_CONNECT_CEILING_MS}ms (shared ceiling)`,
        abortSignal,
      );
      if (abortSignal.aborted) {
        await client.close().catch(() => {});
        throw abortSignal.reason ?? new DOMException("Aborted", "AbortError");
      }
      this.client = client;
      return client;
    } catch (err) {
      this.connectPromise = undefined;
      this.connectAbort = undefined;
      await transport.close().catch(() => {});
      throw err;
    }
  }
}

export function isNotConnectedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message === "Not connected";
}

// Narrowed: do not match arbitrary "timeout" substrings; application errors
// can legitimately contain that word.
export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  const code = (err as { code?: number | string }).code;
  if (code === -32001) return true;
  if (/^connect .* timed out after \d+ms/.test(err.message)) return true;
  if (err.name === "McpError" && /request timed out/i.test(err.message)) {
    return true;
  }
  return false;
}

export function isTransportError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    const msg = err.message.toLowerCase();
    if (
      msg.includes("fetch failed") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("socket hang up") ||
      msg.includes("connection closed") ||
      msg.includes("not connected") ||
      msg.includes("session not found") ||
      msg.includes("session terminated") ||
      msg.includes("network error")
    ) {
      return true;
    }
    const code = (err as { code?: number | string }).code;
    if (typeof code === "number" && code === -32000) {
      return true;
    }
    if (typeof code === "string" && code.startsWith("ECONN")) {
      return true;
    }
  }
  return false;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => done(rejectWith, signal?.reason ?? new DOMException("Aborted", "AbortError"));

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    const done = (action: (v: unknown) => void, v: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action(v);
    };
    const resolveWith = (v: unknown): void => resolve(v as T);
    const rejectWith = (err: unknown): void => reject(err);

    if (signal?.aborted) {
      done(rejectWith, signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => done(rejectWith, new Error(message)), ms);

    promise.then(
      (v) => done(resolveWith, v),
      (err) => done(rejectWith, err),
    );
  });
}
