# Changelog

All notable changes to Copilot CLI Agent Observer are documented here.

This project uses [Keep a Changelog](https://keepachangelog.com/) conventions.

## [0.1.0-alpha] — 2026-04-27

First public alpha release — read-only observability for GitHub Copilot CLI agent sessions.

### Added

- **Execution tree** — hierarchical view of Root Session → Subagents → Tool Calls / Messages
- **Activity timeline** — chronological feed with tool-type badges, agent attribution, and result previews
- **Detail pane** — drill into any node to inspect arguments, results, timestamps, and agent context
- **Stats cards** — live counters for agents, tool calls, and messages
- **Native desktop window** — powered by `@webviewjs/webview` (not a browser tab)
- **Auto-connect** — wires into the active Copilot CLI session event stream automatically
- **Self-bootstrap** — installs dependencies on first load, preferring deterministic `npm ci`
- **Slash command** — `/agent-observer` to open the dashboard window
- **Tools** — `agent_observer_show`, `agent_observer_close`, `observer_dump_summary`

### Fixed

- **Install guidance** — document the real supported install path as a Copilot CLI extension under `~/.copilot/extensions/agent-observer` or project `.github/extensions/agent-observer`
- **Missing slash command diagnosis** — clarify that `copilot plugin install ...` does not activate bundled `.github/extensions`, which is why `/agent-observer` may be missing after plugin-style installation
- **One-command install path** — add `install.ps1` and `install.sh` so users can install the extension without manual folder copying
- **No-restart reload path** — document using Copilot's `extensions_reload` tool from an existing experimental/extensions-enabled session after installing or updating the extension
- **Slash command aliases** — add `/agentobserver` and `/observer` as compatibility aliases for CLI builds that do not dispatch `/agent-observer` reliably

### Changed

- **Packaging stance** — stop advertising plugin/marketplace installation for this project until Copilot CLI supports shipping extensions through that path

### Architecture

- Normalized event data model with buffered startup merge
- WebSocket bridge between extension runtime and React UI
- Platform-native webview via `@webviewjs/webview` (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux)

### Known limitations

- Alpha quality — expect rough edges
- Read-only — cannot influence agent behavior
- Single session — switching sessions resets the view
- No persistence — closing the window discards captured data
- Eval tool is dev-only — `agent_observer_eval` is gated behind `AGENT_OBSERVER_DEV=1`
