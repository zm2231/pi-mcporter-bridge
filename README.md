# pi-mcporter-bridge

A pi extension that turns each of your mcporter-managed MCP servers into a real, first-class pi tool. The agent sees `mcp_<server>__<tool>` directly in its tool list and calls it like any other pi tool. No "search then call" dance, no aggregator middleware, no in-process MCP runtime.

## Why this exists

The original pi-mcporter extension embeds the full `mcporter` npm package in-process and lights up every MCP server in your config whether you want it or not. It also currently fails to load under recent Node versions because the published `mcporter@0.7.3` package ships a CJS/ESM mix that crashes on import.

`mcporter` already has a daemon (`mcporter daemon`) that keeps your MCP servers warm and a bridge (`mcporter serve`) that exposes them over HTTP. The per-server routing (`/mcp/<server>`) is recent; it landed in [openclaw/mcporter#194](https://github.com/openclaw/mcporter/pull/194) and is how Claude Code (and any other coding CLI that consumes mcporter via per-server entries in `~/.claude.json`) gets its MCP tools today. Pi doesn't have an MCP story by default. This extension is that story.

If you already run `mcporter serve` for Claude Code, this extension piggybacks on it. One serve process, multiple clients.

## What it does

The extension reads its settings file, figures out which mcporter servers to surface, opens a Streamable HTTP MCP client to `<baseUrl>/<server>` for each one, calls `tools/list`, and registers every returned tool with pi as `<toolPrefix><server>__<tool>`. The MCP `inputSchema` (JSON Schema) is passed through to pi's tool registry untouched, so the agent gets the real argument shape.

Each tool call is forwarded to the live MCP server through the bridge. Output is rendered, truncated to pi's default size limits, and spilled to a temp file when oversized.

If the bridge dies and comes back (launchd restart, manual kick), the extension reconnects on the next tool call. There is no persistent state on the client side; reconnect is transparent.

## Requirements

You need `mcporter serve` running and reachable. The mcporter docs cover the launchd plist; the short version is one serve process per machine, on a port you choose.

```bash
mcporter serve --http 4748   # foreground, for testing
```

For production, persist this with launchd or a similar supervisor so it survives reboots and crashes.

The extension does not start, restart, or manage the serve process. If the bridge isn't up when pi launches, you'll see per-server `listTools failed` errors in the pi log and zero tools registered. Start the bridge, restart pi.

## Install

```bash
npm install @zmerchant/pi-mcporter-bridge
```

The package exposes a pi extension at `dist/index.js`. pi picks it up via the `pi.extensions` field in `package.json`; no separate registration step.

## Configure

Settings live at `~/.pi/agent/pi-mcporter-bridge.json`. None of the fields are required; the defaults match the conventions in the mcporter docs.

```json
{
  "baseUrl": "http://127.0.0.1:4748/mcp",
  "toolPrefix": "mcp_",
  "callTimeoutMs": 120000,
  "connectTimeoutMs": 5000,
  "defaultEnabled": false,
  "mcporterConfigPath": "~/.mcporter/mcporter.json",
  "disabled": [],
  "servers": []
}
```

### Field reference

`baseUrl` is the root of your serve bridge. Per-server endpoints are derived as `<baseUrl>/<server-name>`. Override per-server with `servers[].url` if you have a server on a different bridge or behind a reverse proxy.

`toolPrefix` is prepended to every registered tool name. The default `mcp_` keeps pi's tool list scannable; set it to `""` to register tools with the bare `<server>__<tool>` shape if you prefer.

`callTimeoutMs` caps how long a single tool call may run before pi aborts it. MCP servers like voicemode and codebase-memory-mcp can run long; default is two minutes.

`connectTimeoutMs` caps the initial connect + `tools/list` handshake per server, from the caller's perspective. Default is 5 seconds, which is generous; if a server fails this it almost certainly has a real problem. The underlying shared handshake also has a hard 60-second internal ceiling as a safety net; you can set `connectTimeoutMs` higher than that, but the shared handshake itself won't wait longer than 60 seconds.

`defaultEnabled` controls discovery. When `false` (the default), the extension only registers servers explicitly listed in `servers[]`. When `true`, it reads `mcporterConfigPath`, takes every key in `mcpServers`, applies `disabled[]` as a denylist, and tries to attach to each remaining server through the serve bridge.

Auto-discovery treats the serve bridge as the source of truth, not your `mcporter.json`. mcporter only exposes "keep-alive" servers through `mcporter serve`, and which servers count as keep-alive is computed at runtime from a mix of the raw `lifecycle:` field, env vars like `MCPORTER_KEEPALIVE`, a hardcoded default-keep-alive name list, and command-pattern matching. Reimplementing that logic on the pi side would drift the moment mcporter ships a new rule. Instead, the extension tries every non-disabled server. If the bridge returns `404 Unknown server '<name>'`, the extension logs a one-liner saying the server isn't exposed and moves on; everything else (real transport failures, auth errors, actual server crashes) is logged as an error. The cost is roughly 50ms per doomed round-trip on localhost; for typical configs with a handful of non-keep-alive servers, total auto-discovery overhead stays well under a second.

Servers explicitly listed in `servers[]` always override auto-discovery, in both directions: an explicit `enabled:false` entry skips a server even if it would otherwise be auto-discovered, and an explicit `enabled:true` entry registers a server even if it appears in `disabled[]`.

`mcporterConfigPath` defaults to `~/.mcporter/mcporter.json`. `~` is expanded to your home directory. Only consulted when `defaultEnabled` is `true`.

`disabled` is a denylist used only with `defaultEnabled: true`. Server names here are skipped during auto-discovery. Useful when you have 20 servers configured but only want most of them.

`servers[]` is the explicit allowlist. Each entry can be a bare string (`"voicemode"`) or an object with optional `url`, `enabled`, `include` (tool-name allowlist), and `exclude` (tool-name denylist).

### Example: explicit allowlist

Register two MCP servers and nothing else. Clean tool list, predictable startup.

```json
{
  "servers": [
    { "name": "voicemode", "enabled": true },
    { "name": "codebase-memory-mcp", "enabled": true }
  ]
}
```

### Example: everything except the noisy ones

Auto-discover from `~/.mcporter/mcporter.json`, skip a few servers you don't want in the agent's tool list.

```json
{
  "defaultEnabled": true,
  "disabled": ["chrome-devtools", "playwright", "mobile-mcp"]
}
```

### Example: narrow a single server's tools

Some MCP servers expose 80+ tools (looking at you, notion). Use `include` to register only the ones you actually call.

```json
{
  "servers": [
    {
      "name": "notion",
      "include": ["search", "query-database", "fetch"]
    }
  ]
}
```

### Example: point at a non-default bridge

Different port, different host, mix of both.

```json
{
  "baseUrl": "http://127.0.0.1:9000/mcp",
  "servers": [
    { "name": "voicemode" },
    { "name": "internal-tool", "url": "http://internal.lan:7000/mcp/internal-tool" }
  ]
}
```

## How it looks at runtime

On pi startup, the extension prints one line per server it registered tools from:

```
[pi-mcporter-bridge] voicemode: registered 2 tool(s) from http://127.0.0.1:4748/mcp/voicemode
[pi-mcporter-bridge] codebase-memory-mcp: registered 7 tool(s) from http://127.0.0.1:4748/mcp/codebase-memory-mcp
```

In the agent's tool list, the names look like this:

```
mcp_voicemode__converse
mcp_codebase_memory_mcp__search_graph
mcp_codebase_memory_mcp__trace_path
```

Tool names get sanitized: any character outside `[A-Za-z0-9_]` is replaced with `_`, and runs of underscores are collapsed. This means a server named `codebase-memory-mcp` shows up as `codebase_memory_mcp` in the prefixed tool name. The pi-visible label (in the UI) preserves the original `server.tool` shape for readability.

## Failure modes

If `mcporter serve` isn't running, every server's `listTools` call fails and the extension logs a one-liner per failure and continues. Pi boots cleanly; you just have no MCP tools.

If the serve bridge restarts mid-session, the next tool call will reconnect transparently. The first call after a restart eats a small latency hit (one extra handshake).

If a server is in your `~/.mcporter/mcporter.json` but isn't actually exposed by the live serve bridge (because it's not keep-alive, or because the bridge hasn't been restarted since you added it), the extension still tries it during auto-discovery. It opens one HTTP POST to `/mcp/<server>`, gets back `404 Unknown server '<name>'` from the bridge, logs a quiet `not exposed by ... (skipped)` line, closes the client, and moves on. No retry, no background reconnect, no zombie state. Other servers continue to register normally.

If you change settings, restart pi. Hot reload isn't supported yet.

## Why per-server, not aggregate?

`mcporter serve` exposes both shapes: `/mcp` (aggregate, tools namespaced `server__tool`) and `/mcp/<server>` (per-server, tools unprefixed). This extension uses the per-server shape because it matches the routing pattern Claude Code uses in `~/.claude.json`, lets you toggle servers individually, and gives the LLM a real tool list it can pick from directly instead of a search-then-call indirection.

If you need the aggregate shape (one giant tool that does everything), use the original pi-mcporter extension or wait for a future `mcporter` action in this one.

## Security

`baseUrl` and per-server `url` are unvalidated by the extension. If you point them at a non-local host (corporate bridge, dev tunnel, anything that isn't `127.0.0.1`), every tool the agent calls is being relayed to that host. The default `127.0.0.1:4748` matches mcporter's launchd convention; anything else is on you.

The extension writes only to `os.tmpdir()` (oversized tool output spilled to disk) and reads only from `~/.pi/agent/pi-mcporter-bridge.json` and your configured `mcporterConfigPath`.

## License

MIT
