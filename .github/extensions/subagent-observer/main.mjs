/**
 * subagent-observer — main extension entry
 *
 * Combines:
 *   1. Webview shell (copilot-webview pattern) for future subagent visualization UI.
 *   2. Live event capture from the observability spike — subagent.*, tool.execution_*,
 *      assistant.message, session.idle — feeding an in-memory store that the webview
 *      (and the observer_dump_summary tool) can query.
 *
 * The webview content is a React + TypeScript app under content/, built with esbuild.
 * It is NOT auto-built — run `npm run build` inside content/ after editing TSX.
 */

import { joinSession } from "@github/copilot-sdk/extension";
import { join } from "node:path";
import { CopilotWebview } from "./lib/copilot-webview.js";

// ── In-memory capture store ─────────────────────────────────────────────────
// This store will later be replaced by or feed into the normalized event model.

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

// ── Webview setup ───────────────────────────────────────────────────────────

const webview = new CopilotWebview({
    extensionName: "subagent_observer",
    contentDir: join(import.meta.dirname, "content"),
    title: "Subagent Observer",
    width: 1100,
    height: 750,
    callbacks: {
        // Page-side `copilot.<name>(...args)` calls land here.
        log: (msg, opts) => session.log(msg, opts),

        // Expose captured data to the webview for rendering
        getSnapshot: () => {
            return JSON.stringify({
                subagents: [...subagentMap.values()],
                toolCalls: [...toolCallMap.values()],
                toolCallsByParent: groupToolCallsByParent([...toolCallMap.values()]),
                recentEvents: eventLog.slice(-100).reverse(),
            });
        },
    },
});

// ── Observer dump tool (preserved from the spike) ───────────────────────────

const observerDumpTool = {
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

            toolCallsByParent: groupToolCallsByParent(tools),

            recentEvents: eventLog.slice(-30).reverse().map((e) => ({
                ts: e.ts,
                type: e.type,
                summary: e.summary,
            })),
        };

        return JSON.stringify(summary, null, 2);
    },
};

// ── Join session ────────────────────────────────────────────────────────────

const session = await joinSession({
    hooks: {
        onSessionStart: async () => {
            await session.log("subagent-observer loaded ✓");
        },
        onSessionEnd: webview.close,
    },
    tools: [
        ...webview.tools,
        observerDumpTool,
    ],
    commands: [{
        name: "subagent-observer",
        description: "Open the subagent observer webview window.",
        handler: webview.show,
    }],
});

// ── Event subscriptions ─────────────────────────────────────────────────────

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

session.on("subagent.selected", (event) => {
    capture("subagent.selected", event.data,
        `◆ agent selected: ${event.data.agentDisplayName}`);
});
session.on("subagent.deselected", (event) => {
    capture("subagent.deselected", event.data, "◇ agent deselected");
});

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

session.on("tool.execution_complete", (event) => {
    const d = event.data;
    const existing = toolCallMap.get(d.toolCallId) ?? { toolCallId: d.toolCallId };
    toolCallMap.set(d.toolCallId, {
        ...existing,
        success: d.success,
        result: d.result?.content?.slice(0, 200),
        completedAt: event.timestamp,
        status: d.success ? "complete" : "failed",
    });
    capture("tool.execution_complete", d,
        `← tool done: ${existing.toolName ?? d.toolCallId} success=${d.success}`);
});

session.on("tool.execution_progress", (event) => {
    const d = event.data;
    capture("tool.execution_progress", d, `⋯ progress [${d.toolCallId}]: ${d.progressMessage}`);
});

session.on("assistant.message", (event) => {
    const d = event.data;
    capture("assistant.message", d,
        `assistant responded (${String(d.content ?? "").length} chars, ${(d.toolRequests ?? []).length} tool requests)`);
});

session.on("session.idle", (event) => {
    capture("session.idle", event.data,
        `session idle (backgroundTasks=${JSON.stringify(event.data?.backgroundTasks ?? [])})`);
});
