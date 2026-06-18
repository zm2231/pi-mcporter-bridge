import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

/**
 * Hard cap (in UTF-8 bytes) on the string we feed into truncateTail.
 * Untrusted MCP servers can return arbitrarily large content; we cap raw
 * at 4 MB during accumulation AND before any pi-side truncation.
 */
const RAW_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Per-part cap inside renderCallResult.
 */
const PART_CAP_BYTES = 1 * 1024 * 1024;

/**
 * Maximum depth boundedSerialize traverses before substituting a summary.
 * Defends against pathological deeply nested payloads that could blow the
 * call stack.
 */
const MAX_SERIALIZE_DEPTH = 32;

/** Reserved room (in bytes) for cap markers so total output stays under cap. */
const MARKER_RESERVE_BYTES = 256;

export type ShapedOutput = {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
};

/**
 * Bounded UTF-8 byte accumulator. Tracks byte cost INCLUDING the separator
 * cost added on each push after the first, reserves MARKER_RESERVE_BYTES of
 * budget so the cap marker fits inside the cap, and trims the last admitted
 * fragment if necessary to make room for the marker.
 */
class BoundedJoiner {
  private parts: string[] = [];
  private totalBytes = 0;
  private capped = false;
  private droppedBytes = 0;
  private readonly capBytes: number;
  private readonly markerReserve: number;
  private readonly separatorBytes: number;

  constructor(
    capBytes: number = RAW_OUTPUT_CAP_BYTES,
    separator: string = "\n",
    markerReserve: number = MARKER_RESERVE_BYTES,
  ) {
    this.capBytes = capBytes;
    this.markerReserve = markerReserve;
    this.separatorBytes = byteLen(separator);
  }

  push(s: string): void {
    if (this.capped) {
      this.droppedBytes += byteLen(s);
      return;
    }
    const cost = byteLen(s) + (this.parts.length > 0 ? this.separatorBytes : 0);
    const budget = this.capBytes - this.markerReserve;
    const remaining = budget - this.totalBytes;
    if (cost <= remaining) {
      this.parts.push(s);
      this.totalBytes += cost;
      return;
    }
    const fragmentBudget = remaining - (this.parts.length > 0 ? this.separatorBytes : 0);
    if (fragmentBudget > 0) {
      const fragment = sliceByBytes(s, fragmentBudget);
      this.parts.push(fragment);
      this.totalBytes += byteLen(fragment) + (this.parts.length > 1 ? this.separatorBytes : 0);
    }
    this.droppedBytes += byteLen(s) - Math.max(fragmentBudget, 0);
    this.capped = true;
  }

  join(separator: string): string {
    const text = this.parts.join(separator).trim();
    if (!this.capped) return text;
    return `${text}\n\n[raw output capped during accumulation: ${formatSize(this.droppedBytes)} omitted]`;
  }

  get isCapped(): boolean {
    return this.capped;
  }
}

export function renderCallResult(raw: unknown): {
  text: string;
  isError: boolean;
} {
  if (!isRecord(raw)) {
    return { text: boundedSerialize(raw, PART_CAP_BYTES), isError: false };
  }
  const isError = raw.isError === true;
  const content = Array.isArray(raw.content) ? raw.content : [];
  const joiner = new BoundedJoiner();
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (joiner.isCapped) break;
    if (item.type === "text" && typeof item.text === "string") {
      joiner.push(clipBytes(item.text, PART_CAP_BYTES));
    } else if (item.type === "resource" && isRecord(item.resource)) {
      // Clip URI before template interpolation so a hostile server cannot
      // force a multi-MB intermediate string into memory.
      const rawUri = typeof item.resource.uri === "string"
        ? item.resource.uri
        : "<resource>";
      const uri = clipBytes(rawUri, 2048);
      const text = typeof item.resource.text === "string"
        ? item.resource.text
        : "";
      joiner.push(
        `[resource ${uri}]${text ? `\n${clipBytes(text, PART_CAP_BYTES)}` : ""}`,
      );
    } else if (item.type === "image") {
      joiner.push("[image content omitted]");
    } else {
      joiner.push(boundedSerialize(item, PART_CAP_BYTES));
    }
  }

  let text = joiner.join("\n");
  if (text.length === 0) {
    const structured = (raw as { structuredContent?: unknown })
      .structuredContent;
    if (structured !== undefined && structured !== null) {
      text = boundedSerialize(structured, RAW_OUTPUT_CAP_BYTES);
    }
  }
  if (text.length === 0) {
    text = boundedSerialize(raw, RAW_OUTPUT_CAP_BYTES);
  }

  return { text, isError };
}

export async function shapeOutput(output: string): Promise<ShapedOutput> {
  // Defense in depth: renderCallResult should already have capped, but if a
  // caller passes us a pre-stringified blob we cap again before truncateTail.
  const { text: bounded, capped: rawCapped } = capRawOutput(output);
  const truncation = truncateTail(bounded, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  if (!truncation.truncated) {
    return { text: truncation.content, truncated: false };
  }

  const fullOutputPath = await writeTempText(bounded);
  const omittedLines = truncation.totalLines - truncation.outputLines;
  const omittedBytes = truncation.totalBytes - truncation.outputBytes;

  let text = truncation.content;
  text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
  text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  text += ` ${omittedLines} line(s) and ${formatSize(omittedBytes)} omitted.`;
  // Be honest about what the temp file contains. If the raw cap fired, the
  // temp file holds the capped version, not the true original.
  const label = rawCapped ? "Capped output" : "Full output";
  text += ` ${label} saved to: ${fullOutputPath}]`;

  return { text, truncated: true, fullOutputPath };
}

/**
 * Cap raw output ONLY when it actually exceeds the hard cap. Pass-through
 * when the input already fits. Returns a flag so callers can label the
 * temp file accurately (capped vs full).
 */
function capRawOutput(output: string): { text: string; capped: boolean } {
  const len = byteLen(output);
  if (len <= RAW_OUTPUT_CAP_BYTES) return { text: output, capped: false };
  // Reserve marker budget only on the truncation path.
  const head = sliceByBytes(output, RAW_OUTPUT_CAP_BYTES - MARKER_RESERVE_BYTES);
  const omitted = len - byteLen(head);
  const text = `${head}\n\n[raw output capped: ${formatSize(omitted)} omitted before pi truncation]`;
  return { text, capped: true };
}

function clipBytes(s: string, maxBytes: number): string {
  if (byteLen(s) <= maxBytes) return s;
  const head = sliceByBytes(s, maxBytes - 64);
  return `${head}\n[clipped: ${formatSize(byteLen(s) - byteLen(head))} omitted]`;
}

/**
 * Walk a JSON-like value and report whether it would serialize under
 * `budgetBytes`. Returns true when the value fits; false when it would
 * exceed the budget. Does NOT materialize the full string for caller use,
 * so safe to call on untrusted schemas/payloads. Bounded recursion via
 * MAX_SERIALIZE_DEPTH prevents stack blowup.
 */
export function fitsWithinBytes(value: unknown, budgetBytes: number): boolean {
  const ctx = { remaining: budgetBytes, overflow: false };
  countNode(value, ctx, 0);
  return !ctx.overflow;
}

function countNode(
  value: unknown,
  ctx: { remaining: number; overflow: boolean },
  depth: number,
): void {
  if (ctx.overflow) return;
  if (depth > MAX_SERIALIZE_DEPTH) {
    ctx.overflow = true;
    return;
  }
  const charge = (n: number): void => {
    if (ctx.overflow) return;
    if (n > ctx.remaining) {
      ctx.overflow = true;
      return;
    }
    ctx.remaining -= n;
  };
  if (value === null) return charge(4);
  switch (typeof value) {
    case "string":
      // Charge the ACTUAL JSON-encoded byte cost via a streaming counter
      // that accounts for escape expansion (e.g. \u0000 = 6 bytes). The
      // counter early-exits once cost exceeds remaining, so a hostile huge
      // string never allocates.
      return chargeJsonStringCost(ctx, value);
    case "number":
    case "boolean":
      return charge(byteLen(String(value)));
    case "undefined":
      return charge(4);
    case "function":
    case "symbol":
      return charge(byteLen(`"[${typeof value}]"`));
  }
  if (Array.isArray(value)) {
    charge(2); // [ ]
    for (let i = 0; i < value.length; i++) {
      if (ctx.overflow) return;
      if (i > 0) charge(1);
      countNode(value[i], ctx, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    charge(2); // { }
    // for..in instead of Object.entries to avoid materializing a [key,value]
    // array. hasOwnProperty.call handles Object.create(null) safely.
    let i = 0;
    for (const k in value as Record<string, unknown>) {
      if (ctx.overflow) return;
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
      if (i > 0) charge(1);
      // Key uses the same escape-aware counter, plus colon.
      chargeJsonStringCost(ctx, k);
      charge(1);
      countNode((value as Record<string, unknown>)[k], ctx, depth + 1);
      i += 1;
    }
    return;
  }
  charge(4);
}

/**
 * Stream-walk a string and charge the ctx for its JSON-encoded UTF-8 byte
 * cost without materializing the encoded form. Early-exits once cost
 * exceeds the remaining budget. JSON.stringify expands per spec:
 *   "      -> \"     (2 bytes)
 *   \      -> \\     (2 bytes)
 *   \b\t\n\f\r       (2 bytes each, escaped form)
 *   other < 0x20 -> \u00XX (6 bytes)
 *   regular -> UTF-8 byte count of that code point
 */
function chargeJsonStringCost(
  ctx: { remaining: number; overflow: boolean },
  s: string,
): void {
  let cost = 2; // opening + closing quotes
  if (cost > ctx.remaining) {
    ctx.overflow = true;
    return;
  }
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) cost += 2;
    else if (
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) cost += 2;
    else if (code < 0x20) cost += 6;
    else if (code < 0x80) cost += 1;
    else if (code < 0x800) cost += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: only consume the pair as 4 bytes when the next code
      // unit is a low surrogate (valid pair). A lone high surrogate would
      // get JSON-escaped as \uXXXX (6 bytes), so charge that.
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        cost += 4;
      } else {
        cost += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate: JSON-escaped as \uXXXX (6 bytes).
      cost += 6;
    } else cost += 3;
    if (cost > ctx.remaining) {
      ctx.overflow = true;
      return;
    }
  }
  ctx.remaining -= cost;
}

/**
 * Walk a JSON-like value and produce a string under `budgetBytes` UTF-8 bytes.
 * Stops descending when budget runs out and substitutes a "[...truncated]"
 * marker. Bounded recursion (MAX_SERIALIZE_DEPTH) prevents stack blowup on
 * adversarial deeply-nested payloads.
 */
function boundedSerialize(value: unknown, budgetBytes: number): string {
  const ctx = { remaining: budgetBytes, overflow: false };
  const out = serializeNode(value, ctx, 0);
  if (ctx.overflow) {
    return `${out}\n[serialization budget exhausted: ${formatSize(budgetBytes)} cap]`;
  }
  return out;
}

function serializeNode(
  value: unknown,
  ctx: { remaining: number; overflow: boolean },
  depth: number,
): string {
  if (ctx.overflow) return "";
  if (depth > MAX_SERIALIZE_DEPTH) {
    ctx.overflow = true;
    return "[max depth]";
  }
  if (value === null) return spend(ctx, "null");
  switch (typeof value) {
    case "string": {
      // Use the escape-aware cost counter (no allocation). If the actual
      // JSON-encoded bytes fit, allocate and emit. If not, clip the raw
      // input to a byte budget BEFORE JSON.stringify so escape expansion
      // can't blow past the budget during the call.
      const probe = { remaining: ctx.remaining, overflow: false };
      chargeJsonStringCost(probe, value);
      if (!probe.overflow) {
        return spend(ctx, JSON.stringify(value));
      }
      // Clip via byte budget. Then probe AGAIN with the actual encoded cost
      // including the " [clipped]" suffix, and shrink further if the escape
      // expansion still overflows. Wrap the whole thing inside JSON.stringify
      // so the result is valid JSON (no `"abc" [clipped]` shape).
      let sliced = sliceByBytes(value, Math.max(0, ctx.remaining - 64));
      let withMarker = `${sliced} [clipped]`;
      let probe2 = { remaining: ctx.remaining, overflow: false };
      chargeJsonStringCost(probe2, withMarker);
      while (probe2.overflow && sliced.length > 0) {
        sliced = sliced.slice(0, Math.max(0, Math.floor(sliced.length / 2)));
        withMarker = `${sliced} [clipped]`;
        probe2 = { remaining: ctx.remaining, overflow: false };
        chargeJsonStringCost(probe2, withMarker);
      }
      return spend(ctx, JSON.stringify(withMarker));
    }
    case "number":
    case "boolean":
      return spend(ctx, String(value));
    case "undefined":
      return spend(ctx, "null");
    case "function":
    case "symbol":
      return spend(ctx, `"[${typeof value}]"`);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    parts.push(spend(ctx, "["));
    for (let i = 0; i < value.length; i++) {
      if (ctx.overflow) break;
      if (i > 0) parts.push(spend(ctx, ","));
      parts.push(serializeNode(value[i], ctx, depth + 1));
    }
    parts.push(spend(ctx, "]"));
    return parts.join("");
  }
  if (typeof value === "object") {
    const parts: string[] = [];
    parts.push(spend(ctx, "{"));
    // for...in instead of Object.entries to avoid array materialization.
    let i = 0;
    for (const k in value as Record<string, unknown>) {
      if (ctx.overflow) break;
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
      if (i > 0) parts.push(spend(ctx, ","));
      // Clip key before JSON.stringify so a 1GB key name never allocates.
      // Use the escape-aware cost counter so escape-heavy keys can't slip
      // through a lower-bound check.
      const keyProbe = { remaining: ctx.remaining, overflow: false };
      chargeJsonStringCost(keyProbe, k);
      if (keyProbe.overflow) {
        const sliceBudget = Math.max(0, ctx.remaining - 64);
        const slicedKey = sliceByBytes(k, sliceBudget);
        // Wrap "[clipped]" suffix inside the JSON string so the result
        // remains valid JSON (no `"key"_clipped` shape).
        parts.push(spend(ctx, JSON.stringify(`${slicedKey} [clipped]`)));
      } else {
        parts.push(spend(ctx, JSON.stringify(k)));
      }
      parts.push(spend(ctx, ":"));
      parts.push(serializeNode((value as Record<string, unknown>)[k], ctx, depth + 1));
      i += 1;
    }
    parts.push(spend(ctx, "}"));
    return parts.join("");
  }
  return spend(ctx, "null");
}

function spend(ctx: { remaining: number; overflow: boolean }, s: string): string {
  if (ctx.overflow) return "";
  const cost = byteLen(s);
  if (cost > ctx.remaining) {
    ctx.overflow = true;
    return "";
  }
  ctx.remaining -= cost;
  return s;
}

/** UTF-8 byte length of a string. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Slice s so the result is at most maxBytes UTF-8 bytes. Encodes once to a
 * Buffer and slices in byte space, avoiding the UTF-16-index pitfall where
 * multi-byte BMP characters produce a slice 2-3x over the byte cap. We back
 * off up to 3 trailing bytes to land on a clean UTF-8 boundary; the
 * subsequent toString("utf8") replaces any partial sequence with U+FFFD.
 */
function sliceByBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // Find the largest valid prefix length <= maxBytes that lands on a
  // UTF-8 boundary. UTF-8 continuation bytes are 0b10xxxxxx, so walk back
  // until we hit a non-continuation byte at position `cut`.
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] !== undefined) && (buf[cut]! & 0xc0) === 0x80) {
    cut -= 1;
  }
  return buf.subarray(0, cut).toString("utf8");
}

async function writeTempText(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcporter-bridge-"));
  const file = join(dir, "output.txt");
  try {
    await writeFile(file, content, "utf8");
    return file;
  } catch (err) {
    // Don't leak the temp directory if writeFile failed. Best-effort cleanup;
    // ignore secondary errors because we want to rethrow the original.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
