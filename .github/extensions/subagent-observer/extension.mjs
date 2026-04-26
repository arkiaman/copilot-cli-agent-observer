/**
 * subagent-observer — observability spike extension
 *
 * Verifies that a `joinSession()` extension can see foreground-session events
 * needed for the planned subagent visualization (issue #1322).
 *
 * Observed event groups:
 *   subagent.*           — started, completed, failed, selected, deselected
 *   tool.execution_*     — start, partial_result, progress, complete
 *   assistant.message    — final assistant turn (includes parentToolCallId context)
 *   user.message         — user turns
 *   session.idle         — turn boundary
 *
 * Spike questions this answers:
 *   1. Are subagent.* events delivered to extension listeners at all?
 *   2. Do tool.execution_* events carry parentToolCallId for sub-agent attribution?
 *   3. Can we build a parent-tool-call → tool-calls index from live events?
 *
 * After loading this extension, trigger a subagent run and then call the
 * `observer_dump_summary` tool to see a structured summary of what was captured.
 */

import { joinSession } from "@github/copilot-sdk/extension";

// ── In-memory capture store ─────────────────────────────────────────────────

/** @type {Array<{ts: string, type: string, summary: string, parentToolCallId?: string, toolCallId?: string}>} */
const eventLog = [];

/** subagents keyed by toolCallId of the spawning tool call */
const subagentMap = new Map();

/** tool calls keyed by toolCallId */
const toolCallMap = new Map();

function capture(type, data, summary) {
    eventLog.push({
        ts: new Date().toISOString(),
        type,
        summary,
        toolCallId: data?.toolCallId,
        parentToolCallId: data?.parentToolCallId,
    });
}

// ── Join the foreground session ─────────────────────────────────────────────

const session = await joinSession({
    hooks: {
        onSessionStart: async () => {
            await session.log("subagent-observer loaded ✓", { level: "info" });
        },
    },
    tools: [
        {
            name: "observer_dump_summary",
            description: [
                "Returns a structured summary of all subagent and tool events captured by the",
                "subagent-observer extension since it was loaded. Use this after triggering a",
                "subagent run to verify that parent-session observability works.",
            ].join(" "),
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () => {
                const subagents = [...subagentMap.values()];
                const tools = [...toolCallMap.values()];

                const summary = {
                    capturedEventCount: eventLog.length,
                    subagentCount: subagents.length,
                    toolCallCount: tools.length,

                    // Core observability verdict
                    observabilityVerdict: {
                        subagentEventsReceived: subagents.length > 0,
                        toolExecutionEventsReceived: tools.length > 0,
                        parentToolCallIdPresent: tools.some((t) => t.parentToolCallId != null),
                    },

                    subagents: subagents.map((s) => ({
                        toolCallId: s.toolCallId,
                        agentName: s.agentName,
                        agentDisplayName: s.agentDisplayName,
                        status: s.status,
                        totalToolCalls: s.totalToolCalls,
                        totalTokens: s.totalTokens,
                        durationMs: s.durationMs,
                        error: s.error,
                    })),

                    // Tool calls grouped by parent (subagent attribution)
                    toolCallsByParent: groupToolCallsByParent(tools),

                    // Raw event log (type + summary, most-recent-first)
                    recentEvents: eventLog.slice(-30).reverse().map((e) => ({
                        ts: e.ts,
                        type: e.type,
                        summary: e.summary,
                    })),
                };

                return JSON.stringify(summary, null, 2);
            },
        },
    ],
});

// ── Event subscriptions ─────────────────────────────────────────────────────

// subagent.started
session.on("subagent.started", (event) => {
    const d = event.data;
    subagentMap.set(d.toolCallId, {
        toolCallId: d.toolCallId,
        agentName: d.agentName,
        agentDisplayName: d.agentDisplayName,
        agentDescription: d.agentDescription,
        status: "started",
        startedAt: event.timestamp,
    });
    capture("subagent.started", d, `▶ subagent started: ${d.agentDisplayName} (toolCallId=${d.toolCallId})`);
});

// subagent.completed
session.on("subagent.completed", (event) => {
    const d = event.data;
    const existing = subagentMap.get(d.toolCallId) ?? {};
    subagentMap.set(d.toolCallId, {
        ...existing,
        ...d,
        status: "completed",
        completedAt: event.timestamp,
    });
    capture("subagent.completed", d,
        `✓ subagent completed: ${d.agentDisplayName} — ${d.totalToolCalls ?? "?"} tool calls, ${d.durationMs ?? "?"}ms`);
});

// subagent.failed
session.on("subagent.failed", (event) => {
    const d = event.data;
    const existing = subagentMap.get(d.toolCallId) ?? {};
    subagentMap.set(d.toolCallId, {
        ...existing,
        ...d,
        status: "failed",
        failedAt: event.timestamp,
    });
    capture("subagent.failed", d, `✗ subagent failed: ${d.agentDisplayName} — ${d.error}`);
});

// subagent.selected / deselected
session.on("subagent.selected", (event) => {
    capture("subagent.selected", event.data,
        `◆ agent selected: ${event.data.agentDisplayName}`);
});
session.on("subagent.deselected", (event) => {
    capture("subagent.deselected", event.data, "◇ agent deselected");
});

// tool.execution_start — key field: parentToolCallId links tool call to a sub-agent
session.on("tool.execution_start", (event) => {
    const d = event.data;
    toolCallMap.set(d.toolCallId, {
        toolCallId: d.toolCallId,
        toolName: d.toolName,
        arguments: d.arguments,
        parentToolCallId: d.parentToolCallId,
        startedAt: event.timestamp,
        status: "running",
    });
    const parentTag = d.parentToolCallId ? ` [parent=${d.parentToolCallId}]` : "";
    capture("tool.execution_start", d, `→ tool start: ${d.toolName}${parentTag}`);
});

// tool.execution_complete
session.on("tool.execution_complete", (event) => {
    const d = event.data;
    const existing = toolCallMap.get(d.toolCallId) ?? { toolCallId: d.toolCallId };
    toolCallMap.set(d.toolCallId, {
        ...existing,
        success: d.success,
        result: d.result?.content?.slice(0, 200),  // trim for memory
        completedAt: event.timestamp,
        status: d.success ? "complete" : "failed",
    });
    capture("tool.execution_complete", d,
        `← tool done: ${existing.toolName ?? d.toolCallId} success=${d.success}`);
});

// tool.execution_progress (ephemeral — note when they arrive)
session.on("tool.execution_progress", (event) => {
    const d = event.data;
    capture("tool.execution_progress", d, `⋯ progress [${d.toolCallId}]: ${d.progressMessage}`);
});

// assistant.message — final turn; toolRequests list is useful for correlation
session.on("assistant.message", (event) => {
    const d = event.data;
    capture("assistant.message", d,
        `assistant responded (${String(d.content ?? "").length} chars, ${(d.toolRequests ?? []).length} tool requests)`);
});

// session.idle — marks end of a turn
session.on("session.idle", (event) => {
    capture("session.idle", event.data,
        `session idle (backgroundTasks=${JSON.stringify(event.data?.backgroundTasks ?? [])})`);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function groupToolCallsByParent(tools) {
    const groups = {};
    for (const t of tools) {
        const key = t.parentToolCallId ?? "__root__";
        if (!groups[key]) groups[key] = [];
        groups[key].push({
            toolCallId: t.toolCallId,
            toolName: t.toolName,
            status: t.status,
        });
    }
    return groups;
}
