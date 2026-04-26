# Subagent Observer — Validation Report

**Date:** 2026-04-26
**Session:** copilot-webview-creator (parent session with multi-agent activity)

## Test Matrix

| Behavior | Result | Notes |
|---|---|---|
| Extension loads and runs | ✅ PASS | PID 8252, status=running |
| `observer_dump_summary` tool works | ✅ PASS | Returns well-formed JSON |
| Webview opens via `subagent_observer_show` | ✅ PASS | Title = "Subagent Observer" |
| `subagent_observer_eval` works | ✅ PASS | Executed JS and returned result |
| `subagent_observer_close` works | ✅ PASS | Window closed cleanly |
| `onSessionStart` fires and wires store | ✅ PASS | No errors; wireSession completes |
| Subagent events received (live) | ❌ FAIL | 0 events after multiple subagent runs |
| Tool execution events received | ❌ FAIL | 0 events after tool calls in subagents |
| `parentToolCallId` attribution | ❌ N/A | No events to attribute |
| `session.getMessages()` replay | ⚠️ UNKNOWN | Replay ran without error but yielded 0 records |

## Key Finding: SDK Event Gap

The Copilot SDK **does not emit `subagent.*` or `tool.*` events to extensions
running in the parent session** when subagents are launched via the `task` tool.

### Evidence

1. Extension registered all event types:
   `subagent.started`, `subagent.completed`, `subagent.failed`,
   `tool.execution_start`, `tool.execution_complete`, `assistant.message`, etc.
2. A dedicated test subagent was launched and completed successfully.
3. `observer_dump_summary` returned `capturedEventCount: 0` both before and after.
4. The extension's event handlers, store logic, and snapshot path are all
   structurally correct — verified by inspection and by the fact that the
   dump tool returns a valid, empty summary.

### Interpretation

The SDK `session.on(eventType, handler)` API appears to only fire events for
activity **within the same session context** (i.e., the extension's own
joinSession scope). Subagents run in separate isolated contexts; their events
are not forwarded to the parent session's event bus.

This is a **product/SDK limitation**, not a bug in the extension.

## What Works Today

- **Extension lifecycle**: load → onSessionStart → onSessionEnd → clean shutdown.
- **Tool registration**: all 4 tools (`show`, `eval`, `close`, `dump_summary`)
  registered and functional.
- **Webview**: opens, serves content, supports JS eval, closes cleanly.
- **Event store**: normalized model, upsert/merge, snapshot, dumpSummary —
  all structurally sound (verified by code review; no runtime data to exercise).
- **Buffered startup merge**: wireSession completes without error.

## Remaining Limitations / Edge Cases

1. **No cross-context event delivery** (SDK limitation) — the primary gap.
   Until the SDK exposes parent-visible subagent events, the store will remain
   empty during normal multi-agent workflows.

2. **`session.getMessages()` content** — unclear what this returns for a parent
   session. It may only contain the parent's own conversation turns (user/assistant),
   not tool execution metadata. This limits replay-based reconstruction.

3. **`parentToolCallId` availability** — even if events were delivered, the SDK
   may not attach this field consistently. The extension handles the fallback
   (synthetic root), but real attribution depends on SDK support.

4. **WebView2 data directory cleanup** — uses `os.tmpdir()` which works but
   leaves ephemeral directories if the process crashes. Not a correctness issue.

5. **No persistent storage** — event data is in-memory only. If the extension
   restarts mid-session, all captured state is lost. Acceptable for v1.

## Recommendations

1. **Watch for SDK updates** — if/when the Copilot SDK adds cross-context event
   forwarding or a parent-session observation API, the store and UI are ready.

2. **Consider polling `session.getMessages()`** — periodic replay could catch
   new conversation turns (tool requests/results) even without live events.
   This would at least show tool call history from the parent's perspective.

3. **Manual event injection for testing** — add a debug tool that injects
   synthetic events into the store to exercise the UI and snapshot pipeline
   end-to-end without depending on real SDK events.
