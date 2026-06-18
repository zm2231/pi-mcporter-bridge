import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type DiscoveredTool, ServerClient } from "./client.js";
import { fitsWithinBytes, renderCallResult, shapeOutput } from "./output.js";
import {
  type BridgeSettings,
  discoverConfiguredServers,
  loadSettings,
  type ServerEntry,
} from "./settings.js";

const PACKAGE_VERSION: string = await readFile(
  new URL("../package.json", import.meta.url),
  "utf8",
)
  .then((raw) => (JSON.parse(raw) as { version: string }).version)
  .catch(() => "0.0.0-dev");

export default async function pimcporterBridge(pi: ExtensionAPI) {
  let settings: BridgeSettings;
  try {
    settings = await loadSettings();
  } catch (err) {
    console.error(
      `[pi-mcporter-bridge] failed to load settings, disabling: ${(err as Error).message}`,
    );
    return;
  }

  const resolved = await resolveServerSet(settings);
  if (resolved.length === 0) {
    console.log(
      "[pi-mcporter-bridge] no servers enabled (set defaultEnabled:true or add servers[]).",
    );
    return;
  }

  // Track every client we keep open so a shutdown hook can close them.
  const lifecycle = new ClientLifecycle();
  registerShutdownHook(pi, lifecycle);

  const registeredNames = new Set<string>();
  for (const server of resolved) {
    if (server.urlInvalid) {
      // settings.ts already logged the underlying URL parse error. We refuse
      // to fall back to baseUrl + name because that would silently call a
      // different server than the user intended.
      console.error(
        `[pi-mcporter-bridge] ${server.name}: skipped due to invalid explicit url in settings`,
      );
      continue;
    }
    const url = resolveServerUrl(server, settings.baseUrl);

    let client: ServerClient;
    try {
      client = new ServerClient(url, PACKAGE_VERSION);
    } catch (err) {
      // Belt-and-suspenders. settings.ts should have caught this already.
      console.error(
        `[pi-mcporter-bridge] ${server.name}: invalid URL "${url}" (skipped): ${(err as Error).message}`,
      );
      continue;
    }

    let tools: DiscoveredTool[];
    try {
      tools = await client.listTools(settings.connectTimeoutMs);
    } catch (err) {
      const message = (err as Error).message;
      if (isNotServedByBridge(message)) {
        console.log(
          `[pi-mcporter-bridge] ${server.name}: not exposed by ${settings.baseUrl} (skipped)`,
        );
      } else {
        console.error(
          `[pi-mcporter-bridge] ${server.name}: listTools failed (${url}): ${message}`,
        );
      }
      await client.close().catch(() => {});
      continue;
    }

    const filtered = filterTools(tools, server);
    let registered = 0;
    for (const tool of filtered) {
      // Clamp tool.name (untrusted, from MCP server) before any log/log path.
      // server.name comes from local config and is trusted.
      const safeToolNameForLog = clampName(tool.name);
      const piName = buildToolName(settings.toolPrefix, server.name, tool.name);
      if (piName === undefined) {
        console.error(
          `[pi-mcporter-bridge] ${server.name}.${safeToolNameForLog}: skipped, name is empty/invalid after sanitization`,
        );
        continue;
      }
      if (registeredNames.has(piName)) {
        console.error(
          `[pi-mcporter-bridge] ${server.name}.${safeToolNameForLog}: skipped, sanitized name "${piName}" already registered by another server`,
        );
        continue;
      }
      // Only mark name reserved AFTER pi.registerTool returns successfully.
      // Otherwise a registerTool throw (bad schema, name collision with a
      // host-registered tool, etc) would orphan the name and stop other
      // tools from this server registering under the same name later.
      try {
        registerProxyTool(pi, settings, server, client, tool, piName);
        registeredNames.add(piName);
        registered += 1;
      } catch (err) {
        console.error(
          `[pi-mcporter-bridge] ${server.name}.${safeToolNameForLog}: pi.registerTool failed (skipped): ${(err as Error).message}`,
        );
      }
    }
    if (registered === 0) {
      await client.close().catch(() => {});
    } else {
      // track() handles a race where shutdown already fired before this
      // server finished registering: it closes the client immediately
      // instead of leaking it.
      await lifecycle.track(client);
    }
    console.log(
      `[pi-mcporter-bridge] ${server.name}: registered ${registered} tool(s) from ${url}`,
    );
  }
}

/**
 * Lifecycle tracker for ServerClients with a "closing" flag. If shutdown
 * fires before all servers finish registering (race during slow startup),
 * track() on later servers closes them immediately instead of leaking them.
 */
class ClientLifecycle {
  private clients: ServerClient[] = [];
  private closing = false;

  async track(client: ServerClient): Promise<void> {
    if (this.closing) {
      // Shutdown already fired; close immediately instead of leaking.
      await client.close().catch(() => {});
      return;
    }
    this.clients.push(client);
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    const snapshot = this.clients.splice(0, this.clients.length);
    await Promise.all(snapshot.map((c) => c.close().catch(() => {})));
  }
}

/**
 * Best-effort hook so long-lived HTTP/SSE MCP sessions get closed on pi
 * shutdown rather than waiting for process exit. pi's hook surface evolves
 * across versions; we probe a small set of names and only attach to ones
 * the host supports. No-op when none are available.
 */
function registerShutdownHook(
  pi: ExtensionAPI,
  lifecycle: ClientLifecycle,
): void {
  const closeAll = async (): Promise<void> => {
    await lifecycle.closeAll();
  };
  const candidate = (pi as unknown as Record<string, unknown>).on;
  if (typeof candidate !== "function") return;
  const on = candidate.bind(pi) as (
    event: string,
    handler: () => unknown,
  ) => void;
  for (const event of ["session_shutdown", "shutdown", "close"]) {
    try {
      on(event, closeAll);
    } catch {
      // Event not supported on this host version. Ignore.
    }
  }
}

async function resolveServerSet(
  settings: BridgeSettings,
): Promise<ServerEntry[]> {
  const explicit = new Map<string, ServerEntry>();
  for (const entry of settings.servers) {
    explicit.set(entry.name, entry);
  }

  const candidates: string[] = [];
  if (settings.defaultEnabled) {
    const discovered = await discoverConfiguredServers(
      settings.mcporterConfigPath,
    );
    for (const name of discovered) candidates.push(name);
  }
  for (const name of explicit.keys()) {
    if (!candidates.includes(name)) candidates.push(name);
  }

  const disabled = new Set(settings.disabled);
  const out: ServerEntry[] = [];
  for (const name of candidates) {
    const override = explicit.get(name);
    if (override) {
      if (!override.enabled) continue;
      out.push(override);
      continue;
    }
    if (disabled.has(name)) continue;
    out.push({ name, enabled: true });
  }
  return out;
}

function resolveServerUrl(server: ServerEntry, baseUrl: string): string {
  if (server.url && server.url.trim().length > 0) return server.url.trim();
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/${server.name}`;
}

function filterTools(
  tools: DiscoveredTool[],
  server: ServerEntry,
): DiscoveredTool[] {
  let out = tools;
  if (server.include && server.include.length > 0) {
    const allow = new Set(server.include);
    out = out.filter((t) => allow.has(t.name));
  }
  if (server.exclude && server.exclude.length > 0) {
    const deny = new Set(server.exclude);
    out = out.filter((t) => !deny.has(t.name));
  }
  return out;
}

/**
 * Cap per-segment length to defend against MCP servers that return very
 * long tool names. pi tool names show up in logs, set entries, schemas, and
 * the registration label, so unbounded growth hurts everywhere.
 */
const MAX_NAME_SEGMENT_CHARS = 128;

/**
 * Build a pi tool name from prefix, server, and tool. Returns undefined when
 * either segment sanitizes to empty (caller must skip the tool). Names that
 * exceed MAX_NAME_SEGMENT_CHARS get truncated.
 */
function buildToolName(
  prefix: string,
  serverName: string,
  toolName: string,
): string | undefined {
  const serverSafe = sanitizeNamePart(serverName).slice(0, MAX_NAME_SEGMENT_CHARS);
  const toolSafe = sanitizeNamePart(toolName).slice(0, MAX_NAME_SEGMENT_CHARS);
  if (serverSafe.length === 0 || toolSafe.length === 0) return undefined;
  return `${prefix}${serverSafe}__${toolSafe}`;
}

// Caps for untrusted server metadata. A misbehaving or hostile MCP server
// can return arbitrarily large descriptions/schemas; we cap before they
// reach pi.registerTool so registration cannot itself blow up memory.
const MAX_DESCRIPTION_CHARS = 8 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
/** Tighter cap for log/error strings where 8KB is already excessive. */
const MAX_LOG_NAME_CHARS = 256;

function registerProxyTool(
  pi: ExtensionAPI,
  settings: BridgeSettings,
  server: ServerEntry,
  client: ServerClient,
  tool: DiscoveredTool,
  piName: string,
) {
  // Clamp every untrusted display string before it reaches pi.registerTool
  // or our own logs. Long names from a hostile server otherwise show up in
  // labels, default descriptions, and log lines.
  const safeServerName = clampDescription(server.name);
  const safeToolName = clampDescription(tool.name);
  const safeQualified = `${safeServerName}.${safeToolName}`;

  const description = clampDescription(
    tool.description?.trim() || `MCP tool ${safeQualified}`,
  );
  // Check size BEFORE coerceObjectSchema, because coerce spreads the original
  // schema into a new object (`{additionalProperties:true, ...schema, type:"object"}`)
  // which would copy a hostile multi-MB schema before our cap could refuse it.
  const schema = Type.Unsafe<Record<string, unknown>>(
    boundedAndCoercedSchema(tool.inputSchema, safeQualified),
  );

  pi.registerTool({
    name: piName,
    label: safeQualified,
    description,
    parameters: schema,
    async execute(_toolCallId, rawParams, signal) {
      const args = (rawParams ?? {}) as Record<string, unknown>;
      const raw = await client.callTool(
        tool.name,
        args,
        settings.connectTimeoutMs,
        settings.callTimeoutMs,
        signal,
      );
      const rendered = renderCallResult(raw);
      const shaped = await shapeOutput(rendered.text);
      if (rendered.isError) {
        throw new Error(shaped.text);
      }
      return {
        content: [{ type: "text", text: shaped.text }],
        details: { server: safeServerName, tool: safeToolName },
      };
    },
  });
}

function clampDescription(text: string): string {
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  const head = text.slice(0, MAX_DESCRIPTION_CHARS);
  return `${head}\n[description truncated by pi-mcporter-bridge: ${text.length - head.length} chars omitted]`;
}

/**
 * Tight clamp for untrusted name strings going into log lines and error
 * messages. 256 chars is plenty for any real tool name; oversized inputs
 * get a short ellipsis to keep error spew bounded.
 */
function clampName(name: string): string {
  if (name.length <= MAX_LOG_NAME_CHARS) return name;
  return `${name.slice(0, MAX_LOG_NAME_CHARS)}...[+${name.length - MAX_LOG_NAME_CHARS} chars]`;
}

/**
 * Cap-then-coerce: walk schema with byte budget BEFORE any spread/copy.
 *
 *  - If schema is missing/non-object: return permissive fallback (no alloc).
 *  - If schema has type:"object" and fits: return as-is (no alloc).
 *  - If schema has other type but fits: return coerced spread (controlled alloc
 *    of a known-small object).
 *  - If schema doesn't fit OR walking throws (proxy/getter): permissive fallback.
 *
 * fitsWithinBytes uses bounded recursion + per-segment byte counting; a
 * hostile multi-MB or deeply-nested schema cannot force a full copy/string.
 */
function boundedAndCoercedSchema(
  schema: Record<string, unknown>,
  context: string,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", additionalProperties: true };
  }
  // Wrap fits-check in try/catch so a proxy/getter throwing during the walk
  // cannot leak unbounded error text into our logs. Untrusted schemas from
  // arbitrary MCP servers might have hostile prototypes when constructed
  // in-process; over the wire JSON parse produces plain objects, but the
  // safe default is to assume nothing.
  let fits = false;
  try {
    fits = fitsWithinBytes(schema, MAX_SCHEMA_BYTES);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const safe = raw.length > 256 ? `${raw.slice(0, 256)}...` : raw;
    console.error(
      `[pi-mcporter-bridge] ${context}: schema walk threw (${safe}), substituting permissive schema`,
    );
    return { type: "object", additionalProperties: true };
  }
  if (!fits) {
    console.error(
      `[pi-mcporter-bridge] ${context}: schema exceeds ${MAX_SCHEMA_BYTES} byte cap (or too deep), substituting permissive schema`,
    );
    return { type: "object", additionalProperties: true };
  }
  try {
    if (schema.type === "object") return schema;
    // Spread is safe here only because the size check already passed.
    return { additionalProperties: true, ...schema, type: "object" };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const safe = raw.length > 256 ? `${raw.slice(0, 256)}...` : raw;
    console.error(
      `[pi-mcporter-bridge] ${context}: schema coerce threw (${safe}), substituting permissive schema`,
    );
    return { type: "object", additionalProperties: true };
  }
}

/**
 * Sanitize a single name segment (server or tool).
 * Replaces illegal chars with _ and collapses runs of _ to a single _.
 * Caller is responsible for joining segments with the __ separator so
 * parsers can split <prefix><server>__<tool> back into parts.
 */
function sanitizeNamePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
}

function isNotServedByBridge(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("unknown server") ||
    (lower.includes("not found") && lower.includes("/mcp/"))
  );
}
