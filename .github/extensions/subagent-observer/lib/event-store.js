/**
 * event-store.js — Normalized in-memory store for subagent visualization
 *
 * Wraps the record factories, upsert helpers, and snapshot builders from
 * event-model.js into a single store object with a clean ingest API.
 *
 * Startup strategy (buffered merge):
 *   1. Live listeners are registered immediately and buffer events.
 *   2. Replay processes session.getMessages() into the store.
 *   3. Buffered live events are merged (dedupe is handled by upsert).
 *   4. The store switches to direct live ingestion.
 *
 * @module event-store
 */

import {
    SYNTHETIC_ROOT_ID,
    SubagentStatus,
    ToolCallStatus,
    ReasoningAvailability,
    upsertSubagent,
    upsertToolCall,
    upsertAssistantMessage,
    classifyReasoning,
    resolveParent,
    buildParentIndex,
    buildTimeline,
} from "./event-model.js";

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * Create a new EventStore instance.  All state is encapsulated; nothing leaks
 * to module scope so tests can create isolated stores.
 */
export function createEventStore() {
    /** @type {Map<string, import("./event-model.js").SubagentRecord>} */
    const subagents = new Map();
    /** @type {Map<string, import("./event-model.js").ToolCallRecord>} */
    const toolCalls = new Map();
    /** @type {Map<string, import("./event-model.js").AssistantMessageRecord>} */
    const messages = new Map();

    /** Total raw events ingested (replay + live), for diagnostics. */
    let ingestedCount = 0;

    // ── Live-event ingestors ────────────────────────────────────────────

    const ingestors = {
        "subagent.started"(event) {
            const d = event.data;
            const ts = event.timestamp ?? new Date().toISOString();
            upsertSubagent(subagents, {
                id: d.toolCallId,
                agentName: d.agentName ?? "",
                agentDisplayName: d.agentDisplayName ?? "",
                agentDescription: d.agentDescription,
                status: SubagentStatus.STARTED,
                startedAt: ts,
                _lastEventTs: ts,
            });
            ingestedCount++;
        },

        "subagent.completed"(event) {
            const d = event.data;
            const ts = event.timestamp ?? new Date().toISOString();
            upsertSubagent(subagents, {
                id: d.toolCallId,
                agentName: d.agentName ?? "",
                agentDisplayName: d.agentDisplayName ?? "",
                status: SubagentStatus.COMPLETED,
                completedAt: ts,
                totalToolCalls: d.totalToolCalls,
                totalTokens: d.totalTokens,
                durationMs: d.durationMs,
                _lastEventTs: ts,
            });
            ingestedCount++;
        },

        "subagent.failed"(event) {
            const d = event.data;
            const ts = event.timestamp ?? new Date().toISOString();
            upsertSubagent(subagents, {
                id: d.toolCallId,
                agentName: d.agentName ?? "",
                agentDisplayName: d.agentDisplayName ?? "",
                status: SubagentStatus.FAILED,
                failedAt: ts,
                error: d.error,
                _lastEventTs: ts,
            });
            ingestedCount++;
        },

        "tool.execution_start"(event) {
            const d = event.data;
            const ts = event.timestamp ?? new Date().toISOString();
            upsertToolCall(toolCalls, {
                id: d.toolCallId,
                toolName: d.toolName ?? "",
                arguments: d.arguments,
                parentToolCallId: resolveParent(d),
                status: ToolCallStatus.RUNNING,
                startedAt: ts,
                _lastEventTs: ts,
            });
            ingestedCount++;
        },

        "tool.execution_complete"(event) {
            const d = event.data;
            const ts = event.timestamp ?? new Date().toISOString();
            upsertToolCall(toolCalls, {
                id: d.toolCallId,
                parentToolCallId: resolveParent(d),
                success: d.success,
                resultPreview: d.result?.content?.slice(0, 200),
                completedAt: ts,
                status: d.success ? ToolCallStatus.COMPLETE : ToolCallStatus.FAILED,
                _lastEventTs: ts,
            });
            ingestedCount++;
        },

        "assistant.message"(event) {
            const d = event.data;
            const ts = event.timestamp ?? new Date().toISOString();
            const reasoning = classifyReasoning(d);
            // Use event id if available, otherwise generate one
            const id = event.id ?? `msg-${ts}-${ingestedCount}`;
            upsertAssistantMessage(messages, {
                id,
                parentToolCallId: resolveParent(d),
                content: d.content ?? "",
                toolRequestCount: (d.toolRequests ?? []).length,
                reasoningAvailability: reasoning.availability,
                reasoningText: reasoning.text,
                timestamp: ts,
                _lastEventTs: ts,
            });
            ingestedCount++;
        },
    };

    // Events we observe but don't create records for (diagnostics only)
    const passiveEvents = new Set([
        "subagent.selected",
        "subagent.deselected",
        "tool.execution_progress",
        "session.idle",
    ]);

    /**
     * Ingest a single raw event (from live subscription or replay).
     * Unknown event types are silently ignored.
     */
    function ingest(eventType, event) {
        const fn = ingestors[eventType];
        if (fn) {
            fn(event);
        } else if (passiveEvents.has(eventType)) {
            ingestedCount++;
        }
    }

    // ── Replay support ──────────────────────────────────────────────────

    /**
     * Process a single message from session.getMessages() replay.
     *
     * Replay messages have a different shape than live events. They are
     * conversation turns with role, content, and optional toolCalls/toolResults.
     * We extract what we can and feed it through the same upsert pipeline.
     */
    function ingestReplayMessage(msg) {
        // Use a counter-suffixed epoch timestamp when none is provided so
        // that replay-start and replay-complete records don't collide on
        // identical timestamps (mergeRecord keeps existing on equal ts).
        const ts = msg.timestamp ?? `1970-01-01T00:00:00.${String(ingestedCount).padStart(3, "0")}Z`;
        const msgParent = resolveParent(msg);

        // Assistant messages with tool requests
        if (msg.role === "assistant") {
            const toolRequests = msg.toolCalls ?? msg.toolRequests ?? [];
            const id = msg.id ?? `replay-msg-${ts}-${ingestedCount}`;

            if (msg.content || toolRequests.length > 0) {
                const reasoning = classifyReasoning(msg);
                upsertAssistantMessage(messages, {
                    id,
                    parentToolCallId: msgParent,
                    content: msg.content ?? "",
                    toolRequestCount: toolRequests.length,
                    reasoningAvailability: reasoning.availability,
                    reasoningText: reasoning.text,
                    timestamp: ts,
                    _lastEventTs: ts,
                });
                ingestedCount++;
            }

            // Each tool request in the assistant message represents a tool call start.
            // Fall back to the message-level parent when the request itself has none.
            for (const req of toolRequests) {
                if (req.toolCallId || req.id) {
                    upsertToolCall(toolCalls, {
                        id: req.toolCallId ?? req.id,
                        toolName: req.toolName ?? req.name ?? "",
                        arguments: req.arguments ?? req.input,
                        parentToolCallId: req.parentToolCallId || msgParent,
                        status: ToolCallStatus.RUNNING,
                        startedAt: ts,
                        _lastEventTs: ts,
                    });
                    ingestedCount++;
                }
            }

            // Handle inline tool results (some replay formats embed results)
            const toolResults = msg.toolResults ?? [];
            for (const res of toolResults) {
                const tcId = res.toolCallId ?? res.id;
                if (tcId) {
                    upsertToolCall(toolCalls, {
                        id: tcId,
                        parentToolCallId: res.parentToolCallId || msgParent,
                        success: res.success !== false,
                        resultPreview: typeof res.content === "string"
                            ? res.content.slice(0, 200)
                            : undefined,
                        completedAt: ts,
                        status: res.success === false ? ToolCallStatus.FAILED : ToolCallStatus.COMPLETE,
                        _lastEventTs: ts,
                    });
                    ingestedCount++;
                }
            }
        }

        // Tool result messages
        if (msg.role === "tool") {
            const toolCallId = msg.toolCallId ?? msg.id;
            if (toolCallId) {
                upsertToolCall(toolCalls, {
                    id: toolCallId,
                    parentToolCallId: msg.parentToolCallId || msgParent,
                    success: msg.success !== false,
                    resultPreview: typeof msg.content === "string"
                        ? msg.content.slice(0, 200)
                        : undefined,
                    completedAt: ts,
                    status: msg.success === false ? ToolCallStatus.FAILED : ToolCallStatus.COMPLETE,
                    _lastEventTs: ts,
                });
                ingestedCount++;
            }
        }
    }

    // ── Snapshot (read-only view of current state) ──────────────────────

    function snapshot() {
        const parentIndex = buildParentIndex(toolCalls);
        const timeline = buildTimeline(subagents, toolCalls, messages);

        // Convert parent index Map to plain object for JSON.
        // Use `toolCallId` key for backward compat with old webview/tools.
        const toolCallsByParent = {};
        for (const [key, ids] of parentIndex) {
            toolCallsByParent[key] = ids.map((id) => {
                const tc = toolCalls.get(id);
                return tc
                    ? { toolCallId: tc.id, toolName: tc.toolName, status: tc.status }
                    : { toolCallId: id };
            });
        }

        // Build a recentEvents array for backward compat with the webview shell.
        // Derived from the timeline so no separate event log is needed.
        const recentEvents = timeline.slice(-100).reverse().map((e) => {
            const r = e.record;
            let summary = "";
            let type = e.kind;
            if (e.kind === "subagent") {
                type = `subagent.${r.status}`;
                summary = `${r.agentDisplayName || r.agentName} (${r.status})`;
            } else if (e.kind === "toolcall") {
                type = r.status === ToolCallStatus.RUNNING ? "tool.execution_start" : "tool.execution_complete";
                summary = `${r.toolName} (${r.status})`;
            } else if (e.kind === "message") {
                type = "assistant.message";
                summary = `assistant (${r.toolRequestCount} tool reqs, ${String(r.content ?? "").length} chars)`;
            }
            return {
                ts: r.startedAt ?? r.timestamp ?? r._lastEventTs,
                type,
                summary,
            };
        });

        return {
            subagents: [...subagents.values()],
            toolCalls: [...toolCalls.values()],
            messages: [...messages.values()],
            toolCallsByParent,
            recentEvents,
            timeline: timeline.map((e) => ({ kind: e.kind, id: e.record.id })),
            stats: {
                subagentCount: subagents.size,
                toolCallCount: toolCalls.size,
                messageCount: messages.size,
                ingestedEventCount: ingestedCount,
                orphanToolCallCount: parentIndex.get(SYNTHETIC_ROOT_ID)?.length ?? 0,
            },
        };
    }

    /**
     * Produce the summary object used by observer_dump_summary.
     * Backwards-compatible shape with the old ad-hoc implementation,
     * but now backed by normalized data.
     */
    function dumpSummary() {
        const snap = snapshot();
        return {
            capturedEventCount: snap.stats.ingestedEventCount,
            subagentCount: snap.stats.subagentCount,
            toolCallCount: snap.stats.toolCallCount,
            messageCount: snap.stats.messageCount,

            observabilityVerdict: {
                subagentEventsReceived: snap.stats.subagentCount > 0,
                toolExecutionEventsReceived: snap.stats.toolCallCount > 0,
                parentToolCallIdPresent: snap.toolCalls.some(
                    (t) => t.parentToolCallId != null && t.parentToolCallId !== SYNTHETIC_ROOT_ID,
                ),
                orphanEventCount: snap.stats.orphanToolCallCount,
            },

            subagents: snap.subagents.map((s) => ({
                toolCallId: s.id,
                agentName: s.agentName,
                agentDisplayName: s.agentDisplayName,
                status: s.status,
                totalToolCalls: s.totalToolCalls,
                totalTokens: s.totalTokens,
                durationMs: s.durationMs,
                error: s.error,
            })),

            toolCallsByParent: snap.toolCallsByParent,

            recentEvents: snap.recentEvents.slice(0, 30),
        };
    }

    /**
     * Clear all store state.  Used on session boundaries so a new
     * onSessionStart does not carry stale data from a prior session.
     */
    function reset() {
        subagents.clear();
        toolCalls.clear();
        messages.clear();
        ingestedCount = 0;
    }

    return {
        ingest,
        ingestReplayMessage,
        snapshot,
        dumpSummary,
        reset,
        /** Expose maps for advanced queries (e.g., webview callbacks) */
        _maps: { subagents, toolCalls, messages },
    };
}

// ── Buffered startup orchestrator ───────────────────────────────────────────

/**
 * Wire an EventStore to a Copilot session using the buffered startup pattern:
 *   1. Subscribe to live events immediately → buffer them.
 *   2. Replay session.getMessages() into the store.
 *   3. Drain the buffer (dedupe handled by upsert).
 *   4. Switch to direct ingestion.
 *
 * @param {ReturnType<typeof createEventStore>} store
 * @param {object} session - The Copilot SDK session object
 * @param {{ log?: (msg: string) => Promise<void> }} [opts]
 * @returns {Promise<() => void>} Cleanup function that removes listeners
 *   registered by this call.  Calling it is optional but recommended when
 *   re-wiring (e.g., on a new onSessionStart) to avoid duplicate subscriptions.
 */
export async function wireSession(store, session, opts = {}) {
    const log = opts.log ?? (() => Promise.resolve());

    // Phase 1: Subscribe live events into a buffer
    /** @type {Array<{ type: string, event: any }>} */
    const buffer = [];
    let buffering = true;
    /** Set to true by the returned cleanup fn so stale listeners no-op. */
    let disposed = false;

    const eventTypes = [
        "subagent.started",
        "subagent.completed",
        "subagent.failed",
        "subagent.selected",
        "subagent.deselected",
        "tool.execution_start",
        "tool.execution_complete",
        "tool.execution_progress",
        "assistant.message",
        "session.idle",
    ];

    /** @type {Array<{ type: string, handler: Function }>} */
    const registeredListeners = [];

    for (const type of eventTypes) {
        const handler = (event) => {
            if (disposed) return; // guard against stale listeners
            if (buffering) {
                buffer.push({ type, event });
            } else {
                store.ingest(type, event);
            }
        };
        session.on(type, handler);
        registeredListeners.push({ type, handler });
    }

    // Phase 2: Replay historical messages
    let replayCount = 0;
    try {
        if (typeof session.getMessages === "function") {
            const history = await session.getMessages();
            if (Array.isArray(history)) {
                for (const msg of history) {
                    store.ingestReplayMessage(msg);
                    replayCount++;
                }
            }
        }
    } catch (err) {
        await log(`⚠ replay failed (non-fatal): ${String(err)}`);
    }

    // Phase 3: Drain buffer then switch to direct ingestion.
    // Use swap-and-loop to avoid races if a listener fires during drain.
    buffering = false;
    let bufferedCount = 0;
    while (buffer.length > 0) {
        const pending = buffer.splice(0);
        bufferedCount += pending.length;
        for (const { type, event } of pending) {
            store.ingest(type, event);
        }
    }

    const snap = store.snapshot().stats;
    await log(
        `subagent-observer: replay=${replayCount} msgs, buffered=${bufferedCount} events, ` +
        `store has ${snap.subagentCount} subagents, ${snap.toolCallCount} tool calls`,
    );

    // Return cleanup function for safe re-wiring across sessions.
    return function unwire() {
        disposed = true;
        for (const { type, handler } of registeredListeners) {
            try { session.off?.(type, handler); } catch { /* session may already be torn down */ }
        }
        registeredListeners.length = 0;
    };
}
