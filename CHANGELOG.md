# Changelog

All notable changes to Copilot CLI Agent Observer are documented here.

This project uses [Keep a Changelog](https://keepachangelog.com/) conventions.

## [0.1.0-alpha] — 2025-04-27

First public alpha release — read-only observability for GitHub Copilot CLI agent sessions.

### Added

- **Execution tree** — hierarchical view of Root Session → Subagents → Tool Calls / Messages
- **Activity timeline** — chronological feed with tool-type badges, agent attribution, and result previews
- **Detail pane** — drill into any node to inspect arguments, results, timestamps, and agent context
- **Stats cards** — live counters for agents, tool calls, and messages
- **Native desktop window** — powered by `@webviewjs/webview` (not a browser tab)
- **Auto-connect** — wires into the active Copilot CLI session event stream automatically
- **Self-bootstrap** — runs `npm install` on first load if dependencies are missing
- **Slash command** — `/agent-observer` to open the dashboard window
- **Tools** — `agent_observer_show`, `agent_observer_eval`, `agent_observer_close`, `observer_dump_summary`

### Architecture

- Normalized event data model with buffered startup merge
- WebSocket bridge between extension runtime and React UI
- Platform-native webview via `@webviewjs/webview` (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux)

### Known limitations

- Alpha quality — expect rough edges
- Read-only — cannot influence agent behavior
- Single session — switching sessions resets the view
- No persistence — closing the window discards captured data
