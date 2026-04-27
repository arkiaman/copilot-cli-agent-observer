/**
 * event-store.js — Normalized in-memory store for subagent visualization
 *
 * Wraps the record factories, upsert helpers, and snapshot builders from
 * event-model.js into a single store object with a clean ingest API.
 *
 * Startup strategy (buffered merge):
 *   1. Live listeners are registered immediately and buffer events.
 *   2. Replay processes persisted session events from events.jsonl when possible
 *      (fallback: session.getMessages()).
 *   3. Buffered live events are merged.
 *   4. A lightweight poller tails events.jsonl for cross-context events the SDK
 *      does not forward over session.on(...).
 *   5. Store switches to direct live ingestion.
 *
 * @module event-store
 */

import { createReadStream, existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";

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
    buildExecutionGraph,
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
    /** Event IDs already seen from persisted log / live bus for dedupe. */
    const seenEventIds = new Set();
    /** Monotonic revision for structural snapshot/json cache invalidation. */
    let revision = 0;
    let cachedSnapshotCoreRevision = -1;
    let cachedSnapshotCore = null;
    let cachedSnapshotJsonRevision = -1;
    let cachedSnapshotJson = "";
    let lastStructuralIngestedCount = 0;

    function markDirty() {
        revision += 1;
        lastStructuralIngestedCount = ingestedCount;
    }

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
        if (event?.id) {
            if (seenEventIds.has(event.id)) return;
            seenEventIds.add(event.id);
        }
        const fn = ingestors[eventType];
        if (fn) {
            fn(event);
            markDirty();
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
        let mutated = false;

        // Preferred path: full SessionEvent objects from SDK history or events.jsonl.
        if (msg?.type && msg?.data) {
            ingest(msg.type, msg);
            return;
        }

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
                mutated = true;
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
                    mutated = true;
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
                    mutated = true;
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
                mutated = true;
            }
        }

        if (mutated) {
            markDirty();
        }
    }

    // ── Snapshot (read-only view of current state) ──────────────────────

    function snapshotCore() {
        if (cachedSnapshotCore && cachedSnapshotCoreRevision === revision) {
            return cachedSnapshotCore;
        }

        const parentIndex = buildParentIndex(toolCalls);
        const executionGraph = buildExecutionGraph(subagents, toolCalls, messages);
        const timeline = buildTimeline(subagents, toolCalls, messages);
        const orphanToolCallIds = new Set(
            executionGraph.orphanNodeKeys
                .map((key) => {
                    const separator = key.indexOf(":");
                    const kind = separator === -1 ? key : key.slice(0, separator);
                    const id = separator === -1 ? "" : key.slice(separator + 1);
                    if (kind === "toolcall") return id;
                    // A subagent node is unified with its spawning task tool call
                    // (they share the same id). When that branch is orphaned the
                    // structural node key is `subagent:<id>`, but the underlying
                    // orphaned execution unit is still a tool call.
                    if (kind === "subagent" && toolCalls.has(id)) return id;
                    return null;
                })
                .filter(Boolean),
        );

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

        cachedSnapshotCore = {
            subagents: [...subagents.values()],
            toolCalls: [...toolCalls.values()],
            messages: [...messages.values()],
            toolCallsByParent,
            executionGraph,
            recentEvents,
            timeline: timeline.map((e) => ({ kind: e.kind, id: e.record.id })),
            statsBase: {
                subagentCount: subagents.size,
                toolCallCount: toolCalls.size,
                messageCount: messages.size,
                orphanToolCallCount: orphanToolCallIds.size,
            },
        };
        cachedSnapshotCoreRevision = revision;
        return cachedSnapshotCore;
    }

    function snapshot() {
        const core = snapshotCore();
        return {
            subagents: core.subagents,
            toolCalls: core.toolCalls,
            messages: core.messages,
            toolCallsByParent: core.toolCallsByParent,
            executionGraph: core.executionGraph,
            recentEvents: core.recentEvents,
            timeline: core.timeline,
            stats: {
                ...core.statsBase,
                ingestedEventCount: ingestedCount,
            },
        };
    }

    function snapshotJson() {
        if (cachedSnapshotJsonRevision === revision && cachedSnapshotJson) {
            return cachedSnapshotJson;
        }
        const core = snapshotCore();
        cachedSnapshotJson = JSON.stringify({
            subagents: core.subagents,
            toolCalls: core.toolCalls,
            messages: core.messages,
            toolCallsByParent: core.toolCallsByParent,
            executionGraph: core.executionGraph,
            recentEvents: core.recentEvents,
            timeline: core.timeline,
            // Keep webview payload stable across passive-only events so
            // progress/idle diagnostics do not force full reparse/re-render.
            stats: {
                ...core.statsBase,
                ingestedEventCount: lastStructuralIngestedCount,
            },
        });
        cachedSnapshotJsonRevision = revision;
        return cachedSnapshotJson;
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
        seenEventIds.clear();
        lastStructuralIngestedCount = 0;
        markDirty();
        cachedSnapshotCore = null;
        cachedSnapshotCoreRevision = -1;
        cachedSnapshotJson = "";
        cachedSnapshotJsonRevision = -1;
    }

    return {
        ingest,
        ingestReplayMessage,
        snapshot,
        snapshotJson,
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
 * @param {{ log?: (msg: string) => Promise<void>, isCurrentGeneration?: () => boolean }} [opts]
 * @returns {Promise<() => void>} Cleanup function that removes listeners
 *   registered by this call.  Calling it is optional but recommended when
 *   re-wiring (e.g., on a new onSessionStart) to avoid duplicate subscriptions.
 */
export async function wireSession(store, session, opts = {}) {
    const log = opts.log ?? (() => Promise.resolve());
    const isCurrentGeneration = opts.isCurrentGeneration ?? (() => true);
    const workspacePath = session.workspacePath;

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

    // Helper: tear down listeners registered by this call.
    function unwire() {
        disposed = true;
        for (const { type, handler } of registeredListeners) {
            try { session.off?.(type, handler); } catch { /* session may already be torn down */ }
        }
        registeredListeners.length = 0;
        if (tailTimer) clearInterval(tailTimer);
        tailTimer = null;
    }

    let replayCount = 0;
    let tailTimer = null;
    let tailInFlight = false;

    const eventsPath = workspacePath ? join(workspacePath, "events.jsonl") : null;
    let tailedBytes = 0;
    let tailRemainder = "";

    async function ingestPersistedChunk(text) {
        let count = 0;
        const endsWithNewline = /\r?\n$/.test(text);
        const lines = text.split(/\r?\n/);
        let remainder = "";

        if (endsWithNewline) {
            lines.pop();
        } else {
            remainder = lines.pop() ?? "";
        }

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const event = JSON.parse(line);
                if (event?.type) {
                    store.ingest(event.type, event);
                    count++;
                }
            } catch {
                // Ignore malformed line fragments; tailer keeps partial final line separately.
            }
        }

        if (remainder.trim()) {
            try {
                const event = JSON.parse(remainder);
                if (event?.type) {
                    store.ingest(event.type, event);
                    count++;
                    remainder = "";
                }
            } catch {
                // Keep trailing partial JSON for the next read.
            }
        }

        return { count, remainder };
    }

    async function replayFromEventLog() {
        if (!eventsPath || !existsSync(eventsPath)) return false;
        let count = 0;
        let remainder = "";
        let bytesRead = 0;
        const stream = createReadStream(eventsPath, { encoding: "utf8" });
        try {
            for await (const chunk of stream) {
                if (disposed || !isCurrentGeneration()) {
                    stream.destroy();
                    break;
                }
                bytesRead += Buffer.byteLength(chunk, "utf8");
                const result = await ingestPersistedChunk(remainder + chunk);
                count += result.count;
                remainder = result.remainder;
            }
        } finally {
            stream.destroy();
        }
        replayCount += count;
        tailedBytes = bytesRead;
        tailRemainder = remainder;
        return true;
    }

    async function replayFromSdkHistory() {
        if (typeof session.getMessages !== "function") return;
        const history = await session.getMessages();
        if (Array.isArray(history)) {
            for (const msg of history) {
                store.ingestReplayMessage(msg);
                replayCount++;
            }
        }
    }

    async function tailEventLogOnce() {
        if (!eventsPath || !existsSync(eventsPath) || disposed) return;
        try {
            const info = await stat(eventsPath);
            if (info.size < tailedBytes) {
                tailedBytes = 0;
                tailRemainder = "";
            }
            if (info.size === tailedBytes) return;

            const fh = await open(eventsPath, "r");
            try {
                const length = info.size - tailedBytes;
                const bufferChunk = Buffer.alloc(length);
                await fh.read(bufferChunk, 0, length, tailedBytes);
                tailedBytes = info.size;

                const text = tailRemainder + bufferChunk.toString("utf8");
                const { remainder } = await ingestPersistedChunk(text);
                tailRemainder = remainder;
            } finally {
                await fh.close();
            }
        } catch (err) {
            await log(`⚠ event log tail failed (non-fatal): ${String(err)}`);
        }
    }

    // Phase 2: Replay persisted historical events when available, otherwise SDK history.
    try {
        const replayedFromLog = await replayFromEventLog();
        if (!replayedFromLog) {
            await replayFromSdkHistory();
        }
        // After the async gap, bail out if a newer session transition
        // has already superseded this one.
        if (!isCurrentGeneration()) {
            unwire();
            return unwire;
        }
    } catch (err) {
        await log(`⚠ replay failed (non-fatal): ${String(err)}`);
    }

    // Re-check generation before draining buffer into the store.
    if (!isCurrentGeneration()) {
        unwire();
        return unwire;
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

    // Phase 4: Tail persisted session event log for cross-context events that the
    // SDK event bus does not forward to extensions.
    if (eventsPath) {
        tailTimer = setInterval(() => {
            if (tailInFlight || disposed) return;
            tailInFlight = true;
            tailEventLogOnce()
                .catch(() => {})
                .finally(() => { tailInFlight = false; });
        }, 1000);
        if (!tailInFlight && !disposed) {
            tailInFlight = true;
            void tailEventLogOnce()
                .catch(() => {})
                .finally(() => { tailInFlight = false; });
        }
    }

    const snap = store.snapshot().stats;
    await log(
        `agent-observer: replay=${replayCount} persisted events, buffered=${bufferedCount} events, ` +
        `store has ${snap.subagentCount} subagents, ${snap.toolCallCount} tool calls`,
    );

    return unwire;
}
