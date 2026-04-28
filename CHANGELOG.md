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

- **Plugin packaging** — add a root `plugin.json` manifest so `/plugin install Rogn/copilot-cli-agent-observer` is recognized as a Copilot CLI plugin repository
- **Plugin docs alignment** — update install guidance for current Copilot CLI behavior, including marketplace-first install flow, direct-install deprecation note, and correct `installed-plugins` storage path

### Changed

- **Marketplace support** — add `.github/plugin/marketplace.json` so repo can be added as its own Copilot CLI marketplace

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
