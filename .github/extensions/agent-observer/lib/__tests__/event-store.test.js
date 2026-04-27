import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createEventStore } from "../event-store.js";
import {
    SYNTHETIC_ROOT_ID,
    SubagentStatus,
    ToolCallStatus,
    ReasoningAvailability,
} from "../event-model.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(type, data, opts = {}) {
    return {
        type,
        data,
        id: opts.id ?? undefined,
        timestamp: opts.timestamp ?? new Date().toISOString(),
    };
}

// ── createEventStore basics ─────────────────────────────────────────────────

describe("createEventStore", () => {
    let store;

    beforeEach(() => {
        store = createEventStore();
    });

    it("starts empty", () => {
        const snap = store.snapshot();
        assert.equal(snap.stats.subagentCount, 0);
        assert.equal(snap.stats.toolCallCount, 0);
        assert.equal(snap.stats.messageCount, 0);
        assert.equal(snap.stats.ingestedEventCount, 0);
    });

    it("reset clears all state", () => {
        store.ingest("subagent.started", makeEvent("subagent.started", {
            toolCallId: "sa-1",
            agentName: "explore",
        }));
        assert.equal(store.snapshot().stats.subagentCount, 1);
        store.reset();
        assert.equal(store.snapshot().stats.subagentCount, 0);
    });
});

// ── Live event ingestion ────────────────────────────────────────────────────

describe("live event ingestion", () => {
    let store;

    beforeEach(() => {
        store = createEventStore();
    });

    it("ingests subagent lifecycle", () => {
        const ts1 = "2025-01-01T00:00:00Z";
        const ts2 = "2025-01-01T00:01:00Z";

        store.ingest("subagent.started", {
            data: { toolCallId: "sa-1", agentName: "explore", agentDisplayName: "Explore" },
            timestamp: ts1,
        });

        let snap = store.snapshot();
        assert.equal(snap.stats.subagentCount, 1);
        assert.equal(snap.subagents[0].status, SubagentStatus.STARTED);

        store.ingest("subagent.completed", {
            data: {
                toolCallId: "sa-1",
                agentName: "explore",
                agentDisplayName: "Explore",
                totalToolCalls: 5,
                totalTokens: 1000,
                durationMs: 3000,
            },
            timestamp: ts2,
        });

        snap = store.snapshot();
        assert.equal(snap.subagents[0].status, SubagentStatus.COMPLETED);
        assert.equal(snap.subagents[0].totalToolCalls, 5);
    });

    it("ingests subagent.failed", () => {
        store.ingest("subagent.failed", {
            data: { toolCallId: "sa-2", agentName: "task", error: "timeout" },
            timestamp: "2025-01-01T00:00:00Z",
        });
        const snap = store.snapshot();
        assert.equal(snap.subagents[0].status, SubagentStatus.FAILED);
        assert.equal(snap.subagents[0].error, "timeout");
    });

    it("ingests tool execution lifecycle", () => {
        store.ingest("tool.execution_start", {
            data: { toolCallId: "tc-1", toolName: "grep", parentToolCallId: "sa-1" },
            timestamp: "2025-01-01T00:00:00Z",
        });

        let snap = store.snapshot();
        assert.equal(snap.stats.toolCallCount, 1);
        assert.equal(snap.toolCalls[0].status, ToolCallStatus.RUNNING);

        store.ingest("tool.execution_complete", {
            data: {
                toolCallId: "tc-1",
                parentToolCallId: "sa-1",
                success: true,
                result: { content: "found 3 matches" },
            },
            timestamp: "2025-01-01T00:01:00Z",
        });

        snap = store.snapshot();
        assert.equal(snap.toolCalls[0].status, ToolCallStatus.COMPLETE);
        assert.equal(snap.toolCalls[0].success, true);
    });

    it("ingests assistant.message with reasoning", () => {
        store.ingest("assistant.message", {
            data: {
                content: "Let me help",
                toolRequests: [{ toolCallId: "tc-1", toolName: "view" }],
                reasoningText: "thinking about it",
                parentToolCallId: "sa-1",
            },
            id: "msg-1",
            timestamp: "2025-01-01T00:00:00Z",
        });

        const snap = store.snapshot();
        assert.equal(snap.stats.messageCount, 1);
        assert.equal(snap.messages[0].content, "Let me help");
        assert.equal(snap.messages[0].toolRequestCount, 1);
        assert.equal(snap.messages[0].reasoningAvailability, ReasoningAvailability.AVAILABLE);
    });

    it("deduplicates events by id", () => {
        const event = {
            data: { toolCallId: "tc-1", toolName: "grep" },
            id: "evt-unique",
            timestamp: "2025-01-01T00:00:00Z",
        };
        store.ingest("tool.execution_start", event);
        store.ingest("tool.execution_start", event);
        assert.equal(store.snapshot().stats.toolCallCount, 1);
    });

    it("ignores unknown event types gracefully", () => {
        store.ingest("unknown.event.type", {
            data: {},
            timestamp: "2025-01-01T00:00:00Z",
        });
        assert.equal(store.snapshot().stats.ingestedEventCount, 0);
    });
});

// ── Replay ingestion ────────────────────────────────────────────────────────

describe("ingestReplayMessage", () => {
    let store;

    beforeEach(() => {
        store = createEventStore();
    });

    it("handles SessionEvent-shaped replay messages (type + data)", () => {
        store.ingestReplayMessage({
            type: "subagent.started",
            data: { toolCallId: "sa-1", agentName: "explore" },
            timestamp: "2025-01-01T00:00:00Z",
        });
        assert.equal(store.snapshot().stats.subagentCount, 1);
    });

    it("handles assistant role replay with tool requests", () => {
        store.ingestReplayMessage({
            role: "assistant",
            content: "I will search",
            toolCalls: [
                { toolCallId: "tc-1", toolName: "grep" },
                { toolCallId: "tc-2", toolName: "view" },
            ],
            timestamp: "2025-01-01T00:00:00Z",
        });

        const snap = store.snapshot();
        assert.equal(snap.stats.messageCount, 1);
        assert.equal(snap.stats.toolCallCount, 2);
    });

    it("handles tool role replay", () => {
        store.ingestReplayMessage({
            role: "tool",
            toolCallId: "tc-1",
            success: true,
            content: "result data",
            timestamp: "2025-01-01T00:00:00Z",
        });

        const snap = store.snapshot();
        assert.equal(snap.stats.toolCallCount, 1);
        assert.equal(snap.toolCalls[0].status, ToolCallStatus.COMPLETE);
    });
});

// ── Snapshot ─────────────────────────────────────────────────────────────────

describe("snapshot", () => {
    it("includes execution graph and timeline", () => {
        const store = createEventStore();
        store.ingest("subagent.started", {
            data: { toolCallId: "sa-1", agentName: "explore" },
            timestamp: "2025-01-01T00:00:00Z",
        });
        store.ingest("tool.execution_start", {
            data: { toolCallId: "tc-1", toolName: "grep", parentToolCallId: "sa-1" },
            timestamp: "2025-01-01T00:01:00Z",
        });

        const snap = store.snapshot();
        assert.ok(snap.executionGraph);
        assert.ok(snap.executionGraph.rootNodeKey);
        assert.ok(snap.timeline.length > 0);
        assert.ok(snap.toolCallsByParent);
    });

    it("snapshotJson returns valid JSON", () => {
        const store = createEventStore();
        store.ingest("subagent.started", {
            data: { toolCallId: "sa-1", agentName: "explore" },
            timestamp: "2025-01-01T00:00:00Z",
        });
        const json = store.snapshotJson();
        const parsed = JSON.parse(json);
        assert.equal(parsed.stats.subagentCount, 1);
    });

    it("snapshot is cached until mutation", () => {
        const store = createEventStore();
        store.ingest("subagent.started", {
            data: { toolCallId: "sa-1", agentName: "explore" },
            timestamp: "2025-01-01T00:00:00Z",
        });
        const json1 = store.snapshotJson();
        const json2 = store.snapshotJson();
        // Exact same string reference due to caching
        assert.equal(json1, json2);
    });
});

// ── dumpSummary ─────────────────────────────────────────────────────────────

describe("dumpSummary", () => {
    it("returns backward-compatible summary shape", () => {
        const store = createEventStore();
        store.ingest("subagent.started", {
            data: { toolCallId: "sa-1", agentName: "explore", agentDisplayName: "Explore" },
            timestamp: "2025-01-01T00:00:00Z",
        });
        store.ingest("tool.execution_start", {
            data: { toolCallId: "tc-1", toolName: "grep", parentToolCallId: "sa-1" },
            timestamp: "2025-01-01T00:01:00Z",
        });

        const summary = store.dumpSummary();
        assert.equal(summary.subagentCount, 1);
        assert.equal(summary.toolCallCount, 1);
        assert.ok(summary.observabilityVerdict);
        assert.equal(summary.observabilityVerdict.subagentEventsReceived, true);
        assert.equal(summary.observabilityVerdict.parentToolCallIdPresent, true);
        assert.ok(Array.isArray(summary.subagents));
        assert.ok(Array.isArray(summary.recentEvents));
    });
});
