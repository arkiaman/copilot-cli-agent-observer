# Changelog

All notable changes to Copilot CLI Agent Observer are documented here.

This project uses [Keep a Changelog](https://keepachangelog.com/) conventions.

## [Unreleased]

### Added

- **Session identity** — each observer window now shows the working directory, git branch, and process ID in the native window title, browser title, and a blue header badge; multiple observer windows from parallel sessions are instantly distinguishable
- **Version marker** — `observer_dump_summary` now reports extension version (e.g. `"version": "1.4.0"`) so users and developers can confirm which code is actually running
- **Command diagnostics** — `observer_dump_summary` includes live identity checks (was the patched map/get/dispatch replaced at runtime?) and a ring buffer of the last 20 command dispatch calls for debugging slash command issues
- **Agent hierarchy graph** — visual graph with connector lines showing main agent → subagent relationships, status badges, descendant counts, and timing
- **Drag-to-resize panels** — VS Code-style handles between Agent Hierarchy, Background Activity, and Subagent Details sections; sizes saved as percentages in localStorage
- **Collapsible sections** — expand/collapse each panel with persistent state in localStorage; Agent Hierarchy starts collapsed by default
- **Zero-subagent usability** — the dashboard is useful immediately from session start, even before any subagents spawn; auto-selects root session, shows root-level tool calls and messages
- **Activity workspace** — unified activity panel with tree view, chronological timeline, search, and type/status filters
- **Detail pane sections** — Arguments and Result Preview disclosure sections for tool calls, Content and Reasoning sections for messages

### Changed

- **UI architecture** — split monolithic `main.tsx` into focused modules: `App.tsx` (layout), `AgentHierarchy.tsx`, `ActivityWorkspace.tsx`, `DetailPane.tsx`, `model.ts`, `helpers.ts`, `types.ts`
- **Background Activity label** — renamed from "Background Subagents" to clarify it includes all background activity, not just subagents
- **Screenshots and GIF** — recaptured at 1920×1080 with rich mock data showing realistic security audit scenario
- **Large-session behavior** — the observer now uses lean snapshots, revision-based polling, and on-demand detail loading so long sessions transfer and render far less data by default

### Fixed

- **"Unknown command" error on `/observer`** — patched `Map.get()` on the SDK's internal `commandHandlers` map so our handler is always returned for `/observer` and `/agent-observer`, even when the SDK clears the map after registration; secondary belt-and-suspenders patch on `_executeCommandAndRespond` injects the handler just before lookup; both patches normalize command names (strip leading `/`) to handle dispatch inconsistencies
- **DetailPane crash** — added optional chaining on `toolRequestCount?.toString()` to prevent crash when selecting messages from the timeline
- **Resize handle reliability** — added pointer capture for consistent drag behavior across elements
- **Root auto-selection** — always falls back to root session when no selection exists, rather than using a one-shot guard
- **Large-memory sessions** — bounded event-store growth and lean transport reduce WebView memory pressure during sessions with thousands of events
- **Default window layout** — the observer now opens wider and keeps the side-by-side layout by default instead of immediately tripping the narrow-window breakpoint

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
- **Slash command** — `/observer` (primary) and `/agent-observer` (alias) to open the dashboard window
- **Tools** — `agent_observer_show`, `agent_observer_close`, `observer_dump_summary`

### Fixed

- **Install guidance** — document the real supported install path as a Copilot CLI extension under `~/.copilot/extensions/agent-observer` or project `.github/extensions/agent-observer`
- **Missing slash command diagnosis** — clarify that `copilot plugin install ...` does not activate bundled `.github/extensions`, which is why `/agent-observer` may be missing after plugin-style installation
- **One-command install path** — add `install.ps1` and `install.sh` so users can install the extension without manual folder copying
- **No-restart reload path** — document using Copilot's `extensions_reload` tool from an existing experimental/extensions-enabled session after installing or updating the extension
- **Observer command alias** — `/observer` alias was added and later removed along with all slash commands; use the `agent_observer_show` tool instead

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
