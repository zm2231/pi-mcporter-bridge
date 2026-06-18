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
  // Set when a configured `url` failed validation; index.ts skips the server.
  urlInvalid?: boolean;
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

  const baseUrl = normalizeBaseUrl(value.baseUrl);
  const toolPrefix = normalizeToolPrefix(value.toolPrefix);
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
    const validated = validateOptionalUrl(entry.url, `server "${name}".url`);
    out.push({
      name,
      url: validated.url,
      urlInvalid: validated.invalid,
      enabled: entry.enabled !== false,
      include: normalizeStringArray(entry.include),
      exclude: normalizeStringArray(entry.exclude),
    });
  }
  return out;
}

// Throws on bad input; we refuse to start rather than reroute to the default.
function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return DEFAULT_BASE_URL;
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!isValidHttpUrl(trimmed)) {
    throw new Error(
      `pi-mcporter-bridge: settings.baseUrl "${trimmed}" is not a valid http(s) URL. Refusing to start so traffic is not silently rerouted. Fix the URL or remove the field to use the default ${DEFAULT_BASE_URL}.`,
    );
  }
  return trimmed;
}

// missing/empty -> use baseUrl + name; bad -> mark invalid so index.ts skips
// rather than silently rerouting.
function validateOptionalUrl(
  value: unknown,
  context: string,
): { url: string | undefined; invalid: boolean } {
  if (typeof value !== "string") return { url: undefined, invalid: false };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { url: undefined, invalid: false };
  if (!isValidHttpUrl(trimmed)) {
    console.error(
      `[pi-mcporter-bridge] ${context} "${trimmed}" is not a valid http(s) URL; this server will be skipped (not silently rerouted to baseUrl)`,
    );
    return { url: undefined, invalid: true };
  }
  return { url: trimmed, invalid: false };
}

// Empty string is honored as a deliberate "no prefix" config.
function normalizeToolPrefix(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TOOL_PREFIX;
  if (value.length === 0) return "";
  if (value.length > 32) {
    console.error(
      `[pi-mcporter-bridge] settings.toolPrefix too long (${value.length} chars, max 32), using default "${DEFAULT_TOOL_PREFIX}"`,
    );
    return DEFAULT_TOOL_PREFIX;
  }
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    console.error(
      `[pi-mcporter-bridge] settings.toolPrefix "${value}" contains characters outside [A-Za-z0-9_], using default "${DEFAULT_TOOL_PREFIX}"`,
    );
    return DEFAULT_TOOL_PREFIX;
  }
  return value;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return out.length > 0 ? out : undefined;
}

// 1-hour ceiling; Node's setTimeout silently wraps past ~24.8 days.
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  const floored = Math.floor(value);
  if (floored > MAX_TIMEOUT_MS) {
    console.error(
      `[pi-mcporter-bridge] timeout ${floored}ms exceeds ${MAX_TIMEOUT_MS}ms ceiling, clamping`,
    );
    return MAX_TIMEOUT_MS;
  }
  return floored;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
