import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

export type ShapedOutput = {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
};

export function renderCallResult(raw: unknown): {
  text: string;
  isError: boolean;
} {
  if (!isRecord(raw)) {
    return { text: stringify(raw), isError: false };
  }
  const isError = raw.isError === true;
  const content = Array.isArray(raw.content) ? raw.content : [];
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "resource" && isRecord(item.resource)) {
      const uri =
        typeof item.resource.uri === "string" ? item.resource.uri : "<resource>";
      const text =
        typeof item.resource.text === "string" ? item.resource.text : "";
      parts.push(`[resource ${uri}]${text ? `\n${text}` : ""}`);
    } else if (item.type === "image") {
      parts.push("[image content omitted]");
    } else {
      parts.push(stringify(item));
    }
  }

  let text = parts.join("\n").trim();
  if (text.length === 0) {
    const structured = (raw as { structuredContent?: unknown })
      .structuredContent;
    if (structured !== undefined && structured !== null) {
      text = stringify(structured);
    }
  }
  if (text.length === 0) {
    text = stringify(raw);
  }

  return { text, isError };
}

export async function shapeOutput(output: string): Promise<ShapedOutput> {
  const truncation = truncateTail(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  if (!truncation.truncated) {
    return { text: truncation.content, truncated: false };
  }

  const fullOutputPath = await writeTempText(output);
  const omittedLines = truncation.totalLines - truncation.outputLines;
  const omittedBytes = truncation.totalBytes - truncation.outputBytes;

  let text = truncation.content;
  text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
  text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  text += ` ${omittedLines} line(s) and ${formatSize(omittedBytes)} omitted.`;
  text += ` Full output saved to: ${fullOutputPath}]`;

  return { text, truncated: true, fullOutputPath };
}

async function writeTempText(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcporter-bridge-"));
  const file = join(dir, "output.txt");
  await writeFile(file, content, "utf8");
  return file;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
