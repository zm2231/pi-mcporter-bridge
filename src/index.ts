import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type DiscoveredTool, ServerClient } from "./client.js";
import { renderCallResult, shapeOutput } from "./output.js";
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

  const registeredNames = new Set<string>();
  for (const server of resolved) {
    const url = resolveServerUrl(server, settings.baseUrl);
    const client = new ServerClient(url, PACKAGE_VERSION);

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
      const piName = buildToolName(settings.toolPrefix, server.name, tool.name);
      if (registeredNames.has(piName)) {
        console.error(
          `[pi-mcporter-bridge] ${server.name}.${tool.name}: skipped, sanitized name "${piName}" already registered by another server`,
        );
        continue;
      }
      registeredNames.add(piName);
      registerProxyTool(pi, settings, server, client, tool, piName);
      registered += 1;
    }
    if (registered === 0) {
      await client.close().catch(() => {});
    }
    console.log(
      `[pi-mcporter-bridge] ${server.name}: registered ${registered} tool(s) from ${url}`,
    );
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

function buildToolName(
  prefix: string,
  serverName: string,
  toolName: string,
): string {
  return `${prefix}${sanitizeNamePart(serverName)}__${sanitizeNamePart(toolName)}`;
}

function registerProxyTool(
  pi: ExtensionAPI,
  settings: BridgeSettings,
  server: ServerEntry,
  client: ServerClient,
  tool: DiscoveredTool,
  piName: string,
) {
  const description =
    tool.description?.trim() || `MCP tool ${server.name}.${tool.name}`;
  const schema = Type.Unsafe<Record<string, unknown>>(
    coerceObjectSchema(tool.inputSchema),
  );

  pi.registerTool({
    name: piName,
    label: `${server.name}.${tool.name}`,
    description,
    parameters: schema,
    async execute(_toolCallId, rawParams, signal) {
      const args = (rawParams ?? {}) as Record<string, unknown>;
      const raw = await client.callTool(
        tool.name,
        args,
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
        details: { server: server.name, tool: tool.name },
      };
    },
  });
}

function coerceObjectSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", additionalProperties: true };
  }
  if (schema.type === "object") return schema;
  return { additionalProperties: true, ...schema, type: "object" };
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
