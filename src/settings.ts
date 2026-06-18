import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:4748/mcp";
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_TOOL_PREFIX = "mcp_";

export type ServerEntry = {
  name: string;
  url?: string;
  enabled: boolean;
  include?: string[];
  exclude?: string[];
};

export type BridgeSettings = {
  baseUrl: string;
  toolPrefix: string;
  callTimeoutMs: number;
  connectTimeoutMs: number;
  defaultEnabled: boolean;
  mcporterConfigPath: string;
  disabled: string[];
  servers: ServerEntry[];
};

const DEFAULT_SETTINGS: BridgeSettings = {
  baseUrl: DEFAULT_BASE_URL,
  toolPrefix: DEFAULT_TOOL_PREFIX,
  callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
  connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
  defaultEnabled: false,
  mcporterConfigPath: "",
  disabled: [],
  servers: [],
};

export function settingsPath(home = homedir()): string {
  return join(home, ".pi", "agent", "pi-mcporter-bridge.json");
}

export function defaultMcporterConfigPath(home = homedir()): string {
  return join(home, ".mcporter", "mcporter.json");
}

export async function loadSettings(home = homedir()): Promise<BridgeSettings> {
  const path = settingsPath(home);
  const fallback: BridgeSettings = {
    ...DEFAULT_SETTINGS,
    mcporterConfigPath: defaultMcporterConfigPath(home),
    disabled: [],
    servers: [],
  };

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(
      `pi-mcporter-bridge: failed to read ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `pi-mcporter-bridge: invalid JSON in ${path}: ${(err as Error).message}`,
    );
  }

  return normalize(parsed, home);
}

export async function discoverConfiguredServers(
  configPath: string,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const servers = parsed.mcpServers;
  if (!isRecord(servers)) return [];
  return Object.keys(servers);
}

function normalize(value: unknown, home: string): BridgeSettings {
  if (!isRecord(value)) {
    throw new Error("pi-mcporter-bridge: settings must be a JSON object.");
  }

  const baseUrl =
    typeof value.baseUrl === "string" && value.baseUrl.trim().length > 0
      ? value.baseUrl.trim().replace(/\/+$/, "")
      : DEFAULT_BASE_URL;
  const toolPrefix =
    typeof value.toolPrefix === "string"
      ? value.toolPrefix
      : DEFAULT_TOOL_PREFIX;
  const callTimeoutMs = positiveInt(value.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);
  const connectTimeoutMs = positiveInt(
    value.connectTimeoutMs,
    DEFAULT_CONNECT_TIMEOUT_MS,
  );
  const defaultEnabled = value.defaultEnabled === true;
  const mcporterConfigPath =
    typeof value.mcporterConfigPath === "string" &&
    value.mcporterConfigPath.trim().length > 0
      ? expandHome(value.mcporterConfigPath.trim(), home)
      : defaultMcporterConfigPath(home);
  const disabled = normalizeStringArray(value.disabled) ?? [];
  const servers = normalizeServers(value.servers);

  return {
    baseUrl,
    toolPrefix,
    callTimeoutMs,
    connectTimeoutMs,
    defaultEnabled,
    mcporterConfigPath,
    disabled,
    servers,
  };
}

function normalizeServers(value: unknown): ServerEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ServerEntry[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      out.push({ name: entry, enabled: true });
      continue;
    }
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name.length === 0) continue;
    out.push({
      name,
      url: typeof entry.url === "string" ? entry.url : undefined,
      enabled: entry.enabled !== false,
      include: normalizeStringArray(entry.include),
      exclude: normalizeStringArray(entry.exclude),
    });
  }
  return out;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return out.length > 0 ? out : undefined;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? Math.floor(value) : fallback;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
