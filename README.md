# Copilot CLI Agent Observer

**Real-time observability for GitHub Copilot CLI agent sessions.**

See what your AI agents are actually doing — every tool call, every subagent spawn, every message — in a live native dashboard that runs alongside your terminal.

![Agent Observer overview — execution tree with stats cards and detail pane](docs/images/hero-overview.png)

## Origin

This project started as a response to [github/copilot-cli#1322](https://github.com/github/copilot-cli/issues/1322) — the need for parent-session observability when working with subagents. It has since grown into a general-purpose agent execution inspector covering the main session, all subagent types, tool calls, and message flows.

---

## Prerequisites

| Requirement | Details |
|---|---|
| **GitHub Copilot CLI** | Installed and working (`copilot` command available) |
| **Experimental mode** | Enable with `/experimental on` or `copilot --experimental` |
| **Node.js** | v20.11+ with `node` and `npm` on PATH |
| **Platform** | Windows (x64), macOS (arm64/x64), Linux (x64) |

## Install

> **This is a Copilot CLI extension, not a plugin.** Do **not** use `copilot plugin install` or `copilot plugin marketplace add` — those commands will fail with `File not found: marketplace.json`. Use the extension install below.

**PowerShell**

```powershell
irm https://raw.githubusercontent.com/Rogn/copilot-cli-agent-observer/master/install.ps1 | iex
```

**bash**

```bash
curl -fsSL https://raw.githubusercontent.com/Rogn/copilot-cli-agent-observer/master/install.sh | bash
```

After install:

- **Already in Copilot CLI?** Ask Copilot to reload extensions (`extensions_reload`), then run `/observer`.
- **Starting fresh?** Run `copilot --experimental`, then `/observer`.

**Manual install:** clone this repo and copy `.github/extensions/agent-observer` to `~/.copilot/extensions/agent-observer`.

Run `/env` to confirm `agent-observer` appears under **Extensions**.

## Usage

Open the observer window:

```
/observer
```

`/agent-observer` also works as an alias.

Or ask the agent: *"Open the agent observer"* — the `agent_observer_show` tool works via natural language too.

### Available tools

| Tool | Description |
|---|---|
| `agent_observer_show` | Open the observer window (or bring it to front) |
| `agent_observer_close` | Close the observer window |
| `observer_dump_summary` | Structured JSON summary of captured events and diagnostics |

### Demo

![Demo walkthrough — observer populating with agents, expanding tool calls, and inspecting details](docs/media/demo-walkthrough.gif)

---

## Troubleshooting

### `/observer` shows "Unknown command: observer"

1. Ask the agent to run `observer_dump_summary` — confirm version is `1.4.0` or later. If older, reinstall with the script above.
2. **Workaround:** ask the agent to "open the agent observer" or call `agent_observer_show` directly. The tool always works, even when the slash command doesn't.

### `/observer` doesn't appear in the command list

1. Run `/env` — `agent-observer` should appear under **Extensions**
2. If not, ensure experimental mode is enabled (`copilot --experimental`)
3. If listed but command missing, ask Copilot to reload extensions (`extensions_reload`)

---

## Compatibility

| Platform | Webview engine | Status |
|---|---|---|
| **Windows** (x64) | WebView2 (Edge/Chromium) | ✅ Known-working |
| **macOS** (arm64/x64) | WKWebView (Safari) | ⚠️ Untested |
| **Linux** (x64) | WebKitGTK | ⚠️ Requires `libwebkit2gtk-4.0` |

**Key limitations:** Alpha quality · Read-only (cannot influence agents) · Requires experimental mode · No session persistence · Extension APIs may change across CLI releases

---

## Acknowledgements

Built on the [copilot-webview-creator](https://github.com/SteveSandersonMS/copilot-webview-creator) pattern by Steve Sanderson. Native window powered by [`@webviewjs/webview`](https://github.com/webviewjs/webview).

## License

[MIT](LICENSE)
