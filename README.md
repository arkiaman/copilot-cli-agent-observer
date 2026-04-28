# Copilot CLI Agent Observer

**Real-time observability for GitHub Copilot CLI agent sessions.**

See what your AI agents are actually doing — every tool call, every subagent spawn, every message — in a live native dashboard that runs alongside your terminal.

![Agent Observer overview — execution tree with stats cards and detail pane](docs/images/hero-overview.png)

---

## The problem

GitHub Copilot CLI is powerful, but its multi-agent architecture is opaque. When the main agent delegates work to explore agents, task agents, or general-purpose subagents, you have no visibility into:

- Which subagents were spawned and why
- What tools each agent called, with what arguments, and what came back
- How long each step took
- Whether the agent is stuck, looping, or making progress

The terminal shows you the final answer. Agent Observer shows you the whole journey.

## Origin

This project started as a response to [github/copilot-cli#1322](https://github.com/github/copilot-cli/issues/1322) — the need for parent-session observability when working with subagents. It has since grown into a general-purpose agent execution inspector covering the main session, all subagent types, tool calls, and message flows.

## Alpha scope

This is an **alpha release** focused on **read-only observability**:

- ✅ Live execution tree showing main agent → subagents → tool calls
- ✅ Chronological activity timeline with tool badges and agent labels
- ✅ Detail inspection pane (arguments, results, timing)
- ✅ Stats cards (agent count, tool call count, message count)
- ✅ Native desktop window (not a browser tab — a real OS window)
- ✅ Auto-connects to the active Copilot CLI session
- ❌ No write operations (cannot modify agent behavior)
- ❌ No persistent storage or export (live session only)

---

## Prerequisites

| Requirement | Details |
|---|---|
| **GitHub Copilot CLI** | Installed and working (`copilot` command available). Tested against CLI `1.0.36` |
| **Plugin support** | No extra experimental toggle required for `copilot plugin ...` on current CLI builds |
| **Node.js** | v20.11+ with `node` and `npm` on PATH (the extension uses `import.meta.dirname`, bootstraps dependencies, and spawns `node` for the native window) |
| **Platform** | Windows (x64), macOS (arm64/x64), Linux (x64). Native webview support varies — see [Compatibility](#compatibility) |

## Install

### Option 1: Marketplace install (recommended)

Add this repo as a marketplace, then install the plugin by name:

```
copilot plugin marketplace add Rogn/copilot-cli-agent-observer
copilot plugin install copilot-cli-agent-observer@copilot-cli-agent-observer
```

This uses the marketplace manifest in `.github/plugin/marketplace.json` and avoids the deprecation warning shown for direct repo installs in current CLI builds.

The plugin manager itself is documented and available in standard CLI help. What remains early-moving is the extension runtime inside `.github/extensions/agent-observer/`, which depends on Copilot CLI extension APIs that may still change between CLI releases.

### Option 2: Direct repo install (still works, but deprecated by CLI)

From a shell:

```shell
copilot plugin install Rogn/copilot-cli-agent-observer
```

Or from an interactive session:

```
/plugin install Rogn/copilot-cli-agent-observer
```

The repo's root `plugin.json` manifest makes the repository installable directly today, but Copilot CLI `1.0.36` warns that direct installs from repos, URLs, and local paths are deprecated in favor of marketplace installs.

### Option 3: Local development install

Install from a local checkout when developing or testing packaging changes:

```bash
copilot plugin install C:\path\to\copilot-cli-agent-observer
```

Use an absolute path or `./relative-path`. Plain `.` is rejected by the current CLI parser.

Installed plugins are stored under `~/.copilot/installed-plugins/...`, and the bundled extension under `.github/extensions/agent-observer/` is loaded from there. If you change a locally installed plugin, reinstall it so Copilot CLI refreshes its cached components.

---

## What happens on first load

When Copilot CLI starts a session with plugin installed:

1. **Bootstrap** — extension checks for `node_modules/` and installs dependencies if needed (first run only, takes a few seconds). When `package-lock.json` is present it uses deterministic `npm ci --omit=dev --no-audit --no-fund`.
2. **Session attach** — the observer wires into the active session's event stream, capturing all agent and tool activity
3. **Ready** — tools and commands are registered; the observer is silently collecting data in the background

No window opens automatically. You choose when to look.

## Usage

### Open the observer window

Use the slash command in any Copilot CLI session:

```
/agent-observer
```

Or ask the agent directly:

> "Open the agent observer"

The agent has access to the `agent_observer_show` tool, so natural-language requests work too.

### Available tools

| Tool | Description |
|---|---|
| `agent_observer_show` | Open the observer window (or bring it to front) |
| `agent_observer_close` | Close the observer window |
| `observer_dump_summary` | Return a structured JSON summary of all captured events (useful in agent conversations) |

`agent_observer_eval` is **not exposed in normal installs**. For local development/debugging only, set `AGENT_OBSERVER_DEV=1` before starting Copilot CLI.

### Reading the dashboard

**Execution tree** — hierarchical view showing Root Session → Subagents → Tool Calls / Messages. Expand any node to drill into its children.

![Timeline feed — chronological activity with tool badges and agent labels](docs/images/timeline-feed.png)

**Activity timeline** — chronological feed of all events with tool-type badges, agent attribution, and result previews.

**Detail pane** — click any node or timeline row to inspect full arguments, results, timestamps, and agent context.

![Detail inspection — drill into a Code Review Agent with full context](docs/images/detail-inspection.png)

### Demo walkthrough

![Demo walkthrough — observer populating with agents, expanding tool calls, and inspecting details](docs/media/demo-walkthrough.gif)

---

## Build & development

The extension has two layers that need separate attention:

### Extension runtime (Node.js)

The extension entry point and event store are plain `.mjs` files — no build step needed.

```bash
cd .github/extensions/agent-observer/
npm ci               # Install runtime dependencies (@webviewjs/webview, ws)
```

### UI (React + TypeScript)

The dashboard UI is a React app bundled with esbuild:

```bash
cd .github/extensions/agent-observer/content/
npm ci               # Install React, esbuild
npm run build        # One-shot production build → dist/main.js
npm run watch        # Rebuild on file changes (dev mode)
```

After rebuilding, reload the observer window to pick up changes (close and reopen, or use `agent_observer_show` with `reload: true`).

### Local plugin packaging test

To validate plugin packaging from local checkout:

```bash
copilot plugin install C:\path\to\copilot-cli-agent-observer
copilot plugin list
```

Re-run `copilot plugin install ...` after local changes. Copilot CLI caches plugin components between installs.

### Project structure

```
plugin.json
.github/plugin/marketplace.json
.github/extensions/agent-observer/
├── extension.mjs          # Bootstrap entry (npm install if needed, then loads main)
├── main.mjs               # Extension logic: session wiring, tools, commands
├── package.json           # Runtime deps (@webviewjs/webview, ws)
├── lib/
│   ├── copilot-webview.js  # Reusable webview host (HTTP server + WebSocket bridge)
│   ├── event-model.js      # Normalized event data model
│   ├── event-store.js      # Event store with buffered startup merge
│   └── webview-child.mjs   # Native window child process
└── content/
    ├── src/main.tsx        # React dashboard source
    ├── style.css           # Dashboard styles
    ├── dist/main.js        # Built bundle (committed)
    └── package.json        # UI build deps (react, esbuild)
```

---

## Compatibility

The native window is powered by [`@webviewjs/webview`](https://github.com/webviewjs/webview), which uses platform-native webview engines:

| Platform | Webview engine | Status |
|---|---|---|
| **Windows** (x64) | WebView2 (Edge/Chromium) | ✅ Known-working |
| **macOS** (arm64/x64) | WKWebView (Safari) | ⚠️ Untested in this alpha |
| **Linux** (x64) | WebKitGTK | ⚠️ Untested in this alpha; likely requires `libwebkit2gtk-4.0` |
| **Other** | — | ❌ Not supported |

### Known limitations

- **Alpha quality** — expect rough edges, especially around session transitions and edge-case event types
- **Extension API churn** — plugin installation is documented and supported, but the underlying extension/runtime APIs used by Agent Observer are still early and may change across Copilot CLI releases
- **Read-only** — the observer cannot influence agent behavior; it is a passive listener
- **Single session** — observes one Copilot CLI session at a time; switching sessions resets the view
- **No persistence** — closing the window or ending the session discards all captured data
- **WebSocket bridge** — the UI connects to the extension via a local WebSocket; firewalls or security software that block localhost connections may interfere
- **Linux webview** — requires GTK/WebKit system libraries that may not be present on minimal or server distros
- **Data exposure** — the observer mirrors raw session content including file paths, tool arguments, result snippets, and assistant messages. Be mindful of this when screen-sharing, streaming, or capturing screenshots from sessions that touch private repos or sensitive data

---

## Acknowledgements

This project builds on the **copilot-webview-creator** pattern by [Steve Sanderson](https://github.com/SteveSandersonMS/copilot-webview-creator), which demonstrated how to give Copilot CLI extensions native desktop windows using `@webviewjs/webview`. The webview hosting layer (`lib/copilot-webview.js`) is derived from that work.

The native webview runtime is provided by the [`@webviewjs/webview`](https://github.com/webviewjs/webview) project.

## License

[MIT](LICENSE) — see LICENSE file for full text.
