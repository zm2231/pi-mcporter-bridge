import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CLIENT_NAME = "pi-mcporter-bridge";
const SHARED_CONNECT_CEILING_MS = 60_000;

export type DiscoveredTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

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
    return await this.withRetry(connectTimeoutMs, signal, async (client) => {
      const res = await client.listTools(undefined, { signal });
      return res.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
          type: "object",
        },
      }));
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    callTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return await this.withRetry(callTimeoutMs, signal, async (client) => {
      return await client.callTool({ name, arguments: args }, undefined, {
        timeout: callTimeoutMs,
        signal,
      });
    });
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

  private async withRetry<T>(
    connectTimeoutMs: number,
    signal: AbortSignal | undefined,
    op: (client: Client) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted();
      const client = await this.connect(connectTimeoutMs, signal);
      signal?.throwIfAborted();
      try {
        return await op(client);
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt === 0 && isTransportError(err)) {
          await this.close();
          continue;
        }
        throw err;
      }
    }
    throw new Error("unreachable");
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

function isTransportError(err: unknown): boolean {
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
    const timer = setTimeout(() => reject(new Error(message)), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
