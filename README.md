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
- ✅ Agent hierarchy graph with connector lines and status badges
- ✅ Chronological activity timeline with tool badges, agent labels, and result previews
- ✅ Detail inspection pane (arguments, results, timing, lineage)
- ✅ Stats cards (agent count, tool call count, message count, events ingested)
- ✅ Drag-to-resize panels — VS Code-style handles between sections, sizes saved to localStorage
- ✅ Collapsible sections with persistent expand/collapse state
- ✅ Works without subagents — useful from the moment a session starts, even before agents spawn
- ✅ Multi-window identity — each observer window shows its session's project, branch, and PID so parallel sessions are distinguishable
- ✅ Large-session performance improvements — lean snapshot transport, revision-based polling, and on-demand detail loading keep long sessions responsive
- ✅ Native desktop window (not a browser tab — a real OS window)
- ✅ Auto-connects to the active Copilot CLI session
- ❌ No write operations (cannot modify agent behavior)
- ❌ No session history export (live session only; UI layout preferences persist locally)

---

## Prerequisites

| Requirement | Details |
|---|---|
| **GitHub Copilot CLI** | Installed and working (`copilot` command available). Tested against CLI `1.0.37` |
| **Experimental mode** | **Required for Agent Observer runtime.** Enable with `/experimental on` or start CLI with `copilot --experimental`. The observer depends on the `EXTENSIONS` experimental feature flag |
| **Node.js** | v20.11+ with `node` and `npm` on PATH (the extension uses `import.meta.dirname`, bootstraps dependencies, and spawns `node` for the native window) |
| **Platform** | Windows (x64), macOS (arm64/x64), Linux (x64). Native webview support varies — see [Compatibility](#compatibility) |

## Install

**Agent Observer is a Copilot CLI extension, not a Copilot CLI plugin.** Do **not** use `copilot plugin marketplace add Rogn/copilot-cli-agent-observer` or `copilot plugin install Rogn/copilot-cli-agent-observer`. This repo intentionally ships no `marketplace.json` or `plugin.json` manifest, because current Copilot CLI plugin packaging does **not** activate bundled `.github/extensions/...` content.

If you try the marketplace command anyway, Copilot CLI fails with `File not found: marketplace.json ...`. That error is expected for this repo. Use extension install steps below instead.

### Option 1: User extension install (recommended)

One-command install:

**PowerShell**

```powershell
irm https://raw.githubusercontent.com/Rogn/copilot-cli-agent-observer/master/install.ps1 | iex
```

**bash**

```bash
curl -fsSL https://raw.githubusercontent.com/Rogn/copilot-cli-agent-observer/master/install.sh | bash
```

Those scripts download this repo, copy `.github/extensions/agent-observer` into `~/.copilot/extensions/agent-observer`, and replace any previous install.

After install, load the extension:

- **Already in Copilot CLI with experimental/extensions enabled?** Ask Copilot to reload extensions (`extensions_reload`), then run `/observer`.
- **Starting fresh?** Run `copilot --experimental`, then `/env` to confirm and `/observer` to launch.

If Copilot CLI is already running without experimental/extensions enabled, start a new session with `copilot --experimental`.

Manual install:

1. Clone or download this repo.
2. Copy `.github/extensions/agent-observer` into your user extensions directory as `~/.copilot/extensions/agent-observer`.
3. Load the extension using either the in-session reload or fresh-start path above.

**PowerShell**

```powershell
git clone https://github.com/Rogn/copilot-cli-agent-observer.git
New-Item -ItemType Directory -Force $HOME\.copilot\extensions | Out-Null
Copy-Item `
  .\copilot-cli-agent-observer\.github\extensions\agent-observer `
  $HOME\.copilot\extensions\agent-observer `
  -Recurse -Force
copilot --experimental
```

**bash**

```bash
git clone https://github.com/Rogn/copilot-cli-agent-observer.git
mkdir -p ~/.copilot/extensions
cp -R ./copilot-cli-agent-observer/.github/extensions/agent-observer ~/.copilot/extensions/agent-observer
copilot --experimental
```

Inside Copilot CLI, run `/env` to confirm `agent-observer` is listed under **Extensions**.

### Option 2: Project-local extension install

If you want Agent Observer only for one project, copy the same folder into that project's `.github/extensions/agent-observer` and run Copilot from that project root:

```text
your-project/
└── .github/
    └── extensions/
        └── agent-observer/
```

This is convenient for contributors and for sharing a pinned extension version inside a repository.

If Copilot CLI is already open with experimental/extensions enabled, ask Copilot to reload extensions after copying. Otherwise start `copilot --experimental` from the project root.

### Option 3: Local development install

For local development, either:

- work directly from a repo that contains `.github/extensions/agent-observer`, or
- copy your working tree's `.github/extensions/agent-observer` into `~/.copilot/extensions/agent-observer`

After local changes, copy the updated folder if needed, then either ask Copilot to reload extensions in an existing experimental/extensions-enabled session or restart with `copilot --experimental`.

---

## What happens on first load

When Copilot CLI starts a session with Agent Observer available as a user or project extension **and experimental mode enabled**:

1. **Bootstrap** — extension checks for `node_modules/` and installs dependencies if needed (first run only, takes a few seconds). When `package-lock.json` is present it uses deterministic `npm ci --omit=dev --no-audit --no-fund`.
2. **Session attach** — the observer wires into the active session's event stream, capturing all agent and tool activity
3. **Ready** — tools and commands are registered; the observer is silently collecting data in the background

No window opens automatically. You choose when to look.

## Usage

### Open the observer window

Use a slash command in any Copilot CLI session:

```
/observer
```

`/observer` is the primary command. `/agent-observer` is also available as an alias.

You can also ask the agent directly:

> "Open the agent observer"

The agent has access to the `agent_observer_show` tool, so natural-language requests work too.

### Available tools

| Tool | Description |
|---|---|
| `agent_observer_show` | Open the observer window (or bring it to front) |
| `agent_observer_close` | Close the observer window |
| `observer_dump_summary` | Return a structured JSON summary of all captured events, extension version, and command diagnostics (useful for debugging and in agent conversations) |

`agent_observer_eval` is **not exposed in normal installs**. For local development/debugging only, set `AGENT_OBSERVER_DEV=1` before starting Copilot CLI. That same flag also enables Agent Observer startup diagnostic logs.

### Reading the dashboard

**Session badge** — the blue chip in the header shows which session this window belongs to (e.g. `my-project @ main (12345)`). The same label appears in the native window title bar and OS taskbar, making it easy to switch between parallel observer windows.

**Agent Hierarchy** — collapsible graph showing the main agent with connector lines to each subagent. Click any node to see its details. Starts collapsed by default; expand it when you want the big picture.

**Execution tree** — hierarchical view showing Root Session → Subagents → Tool Calls / Messages. Expand any node to drill into its children.

![Timeline feed — chronological activity with tool badges and agent labels](docs/images/timeline-feed.png)

**Activity timeline** — chronological feed of all events with tool-type badges, agent attribution, and result previews. Switch between tree and timeline views, search by keyword, and filter by event type or status.

**Detail pane** — click any node or timeline row to inspect full arguments, results, timestamps, and agent context.

![Detail inspection — drill into a grep tool call with arguments and result preview](docs/images/detail-inspection.png)

**Resizable sections** — drag the handles between panels to resize them. Sizes are saved to localStorage and restored on reload.

The dashboard works from the moment your session starts — even before any subagents spawn. Stats cards, the timeline, and the detail pane all show root-level activity immediately.

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

### Local extension install test

To validate a local checkout end to end:

1. Copy `.github/extensions/agent-observer` into `~/.copilot/extensions/agent-observer`
2. If a Copilot session is already open with experimental/extensions enabled, ask Copilot to reload extensions (`extensions_reload`). Otherwise start a clean session with `copilot --experimental`
3. Run `/env` and confirm `agent-observer` appears under **Extensions**
4. Run `/observer` (or `/agent-observer`) to open the window

If you are developing **inside this repo**, do **not** also keep a user-level install enabled at `~/.copilot/extensions/agent-observer`. Copilot will load both copies, and `/observer` can open **two windows**.

### Project structure

```
.github/extensions/agent-observer/
├── extension.mjs          # Bootstrap entry (npm install if needed, then loads main)
├── main.mjs               # Extension logic: session identity, wiring, tools, commands
├── package.json           # Runtime deps (@webviewjs/webview, ws)
├── lib/
│   ├── copilot-webview.js  # Reusable webview host (HTTP server + WebSocket bridge)
│   ├── event-model.js      # Normalized event data model
│   ├── event-store.js      # Event store with buffered startup merge
│   └── webview-child.mjs   # Native window child process
└── content/
    ├── src/
    │   ├── main.tsx            # React entry point
    │   ├── App.tsx             # Root layout, resize handles, section orchestration
    │   ├── AgentHierarchy.tsx  # Agent hierarchy graph with connector lines
    │   ├── ActivityWorkspace.tsx# Activity tree / timeline with filters
    │   ├── DetailPane.tsx      # Detail inspection pane (subagent, tool, message)
    │   ├── model.ts            # Client-side data model and derived views
    │   ├── helpers.ts          # Shared utilities (formatting, text, status)
    │   └── types.ts            # TypeScript type definitions
    ├── style.css           # Dashboard styles
    ├── dist/main.js        # Built bundle (committed)
    └── package.json        # UI build deps (react, esbuild)
```

---

## Troubleshooting

### `/observer` shows "Unknown command: observer"

This is a known SDK-level timing issue where the command handler map loses entries after registration. The extension includes patches that work around this for most setups. If you see the error:

1. **Check your version** — ask the agent to run `observer_dump_summary`. Look for `"version": "1.4.0"` or later. If you see an older version (or no `version` field), reinstall:
   ```powershell
   irm https://raw.githubusercontent.com/Rogn/copilot-cli-agent-observer/master/install.ps1 | iex
   ```

2. **Use the tool instead** — ask the agent to "open the agent observer" or call `agent_observer_show` directly. The tool always works, even when the slash command doesn't.

3. **Collect diagnostics** — if the error persists on v1.4.0+, ask the agent to run `observer_dump_summary` and share the `diagnostics` and `live` sections. Key signals:
   - `live.mapIsOriginal: false` → the SDK replaced the internal map after patching
   - `live.getIsPatched: false` → the patched `.get()` was overwritten
   - `mapGetCalls` showing `"/observer"` → command names arrive with a leading slash (normalization should handle this, but useful to confirm)

### The window opens but `/observer` still errors

This is expected behavior in some cases — the error is cosmetic. The slash command dispatch and the tool dispatch are separate paths. Even when the slash command errors, the window may have already opened via the tool path. You can safely ignore the error message and use the observer normally.

### `/observer` doesn't appear in the command list

Verify the extension loaded correctly:
1. Run `/env` in Copilot CLI — `agent-observer` should appear under **Extensions**
2. If not, ensure experimental mode is enabled (`/experimental on` or `copilot --experimental`)
3. If the extension is listed but the command isn't, ask the agent to reload extensions (`extensions_reload`)

### The observer opens two windows

This usually means Copilot loaded **two copies** of the extension:

- a **user-level install** from `~/.copilot/extensions/agent-observer`
- and a **project-local install** from `.github/extensions/agent-observer`

This is common while developing **inside this repository**.

**Fix:** remove the user-level copy while testing the project-local one:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.copilot\extensions\agent-observer"
```

Then ask Copilot to reload extensions (`extensions_reload`) or restart Copilot CLI.

### The default layout looks wrong on first open

If the detail pane starts stacked below the activity pane or the initial layout looks cramped, you are likely running an older build. Current versions open wider by default and keep the side-by-side layout until the window is actually narrow.

1. Ask the agent to run `observer_dump_summary`
2. Confirm you see `"version": "1.4.0"` or later
3. If not, reinstall with:

```powershell
irm https://raw.githubusercontent.com/Rogn/copilot-cli-agent-observer/master/install.ps1 | iex
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
- **Experimental runtime dependency** — Agent Observer depends on Copilot CLI's `EXTENSIONS` experimental feature flag
- **Manual installation for now** — current Copilot CLI plugin packaging does not load bundled extensions, so Agent Observer must be installed as a user or project extension
- **Extension API churn** — the underlying extension/runtime APIs used by Agent Observer are still early and may change across Copilot CLI releases
- **Read-only** — the observer cannot influence agent behavior; it is a passive listener
- **One window per session** — each observer instance watches one Copilot CLI session; parallel sessions each get their own observer window (identified by project/branch/PID in the title bar)
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
