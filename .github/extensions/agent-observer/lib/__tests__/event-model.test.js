import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    SYNTHETIC_ROOT_ID,
    SubagentStatus,
    ToolCallStatus,
    ReasoningAvailability,
    createSubagentRecord,
    createToolCallRecord,
    createAssistantMessageRecord,
    mergeRecord,
    upsertSubagent,
    upsertToolCall,
    upsertAssistantMessage,
    classifyReasoning,
    resolveParent,
    buildParentIndex,
    buildExecutionGraph,
    buildTimeline,
} from "../event-model.js";

// ── Record factories ────────────────────────────────────────────────────────

describe("createSubagentRecord", () => {
    it("returns defaults with the given id", () => {
        const r = createSubagentRecord("sa-1");
        assert.equal(r.id, "sa-1");
        assert.equal(r.status, SubagentStatus.STARTED);
        assert.equal(r.agentName, "");
    });

    it("applies overrides", () => {
        const r = createSubagentRecord("sa-2", {
            agentName: "explore",
            status: SubagentStatus.COMPLETED,
        });
        assert.equal(r.agentName, "explore");
        assert.equal(r.status, SubagentStatus.COMPLETED);
    });
});

describe("createToolCallRecord", () => {
    it("defaults parentToolCallId to SYNTHETIC_ROOT_ID", () => {
        const r = createToolCallRecord("tc-1");
        assert.equal(r.parentToolCallId, SYNTHETIC_ROOT_ID);
        assert.equal(r.status, ToolCallStatus.RUNNING);
    });
});

describe("createAssistantMessageRecord", () => {
    it("defaults reasoning to UNSUPPORTED", () => {
        const r = createAssistantMessageRecord("msg-1");
        assert.equal(r.reasoningAvailability, ReasoningAvailability.UNSUPPORTED);
        assert.equal(r.toolRequestCount, 0);
    });
});

// ── mergeRecord ─────────────────────────────────────────────────────────────

describe("mergeRecord", () => {
    it("newer timestamp overwrites mutable fields", () => {
        const existing = {
            id: "x",
            status: "started",
            agentName: "explore",
            _lastEventTs: "2025-01-01T00:00:00Z",
        };
        const incoming = {
            status: "completed",
            agentName: "",
            _lastEventTs: "2025-01-01T00:01:00Z",
        };
        const merged = mergeRecord(existing, incoming, ["agentName"]);
        assert.equal(merged.status, "completed");
        // identity field should NOT be blanked
        assert.equal(merged.agentName, "explore");
    });

    it("equal timestamp keeps existing for mutable fields", () => {
        const ts = "2025-01-01T00:00:00Z";
        const existing = { id: "x", status: "started", _lastEventTs: ts };
        const incoming = { status: "completed", _lastEventTs: ts };
        const merged = mergeRecord(existing, incoming);
        assert.equal(merged.status, "started");
    });

    it("identity field accepts real value replacing SYNTHETIC_ROOT_ID", () => {
        const existing = {
            id: "tc-1",
            parentToolCallId: SYNTHETIC_ROOT_ID,
            _lastEventTs: "2025-01-01T00:01:00Z",
        };
        const incoming = {
            parentToolCallId: "sa-1",
            _lastEventTs: "2025-01-01T00:00:00Z", // older!
        };
        const merged = mergeRecord(existing, incoming, ["parentToolCallId"]);
        assert.equal(merged.parentToolCallId, "sa-1");
    });

    it("never overwrites primary key id", () => {
        const existing = { id: "original", _lastEventTs: "2025-01-01T00:00:00Z" };
        const incoming = { id: "hacked", _lastEventTs: "2099-01-01T00:00:00Z" };
        const merged = mergeRecord(existing, incoming);
        assert.equal(merged.id, "original");
    });
});

// ── Upsert helpers ──────────────────────────────────────────────────────────

describe("upsertSubagent", () => {
    it("creates record on first call", () => {
        const map = new Map();
        const r = upsertSubagent(map, { id: "sa-1", agentName: "task" });
        assert.equal(map.size, 1);
        assert.equal(r.agentName, "task");
    });

    it("merges on second call", () => {
        const map = new Map();
        upsertSubagent(map, {
            id: "sa-1",
            agentName: "task",
            status: SubagentStatus.STARTED,
            _lastEventTs: "2025-01-01T00:00:00Z",
        });
        upsertSubagent(map, {
            id: "sa-1",
            status: SubagentStatus.COMPLETED,
            _lastEventTs: "2025-01-01T00:01:00Z",
        });
        assert.equal(map.size, 1);
        const r = map.get("sa-1");
        assert.equal(r.status, SubagentStatus.COMPLETED);
        assert.equal(r.agentName, "task"); // identity preserved
    });
});

describe("upsertToolCall", () => {
    it("creates and merges tool call records", () => {
        const map = new Map();
        upsertToolCall(map, {
            id: "tc-1",
            toolName: "powershell",
            _lastEventTs: "2025-01-01T00:00:00Z",
        });
        upsertToolCall(map, {
            id: "tc-1",
            status: ToolCallStatus.COMPLETE,
            success: true,
            _lastEventTs: "2025-01-01T00:01:00Z",
        });
        const r = map.get("tc-1");
        assert.equal(r.toolName, "powershell");
        assert.equal(r.status, ToolCallStatus.COMPLETE);
    });
});

describe("upsertAssistantMessage", () => {
    it("creates and merges message records", () => {
        const map = new Map();
        upsertAssistantMessage(map, {
            id: "msg-1",
            content: "hello",
            _lastEventTs: "2025-01-01T00:00:00Z",
        });
        upsertAssistantMessage(map, {
            id: "msg-1",
            content: "hello updated",
            _lastEventTs: "2025-01-01T00:01:00Z",
        });
        assert.equal(map.size, 1);
        assert.equal(map.get("msg-1").content, "hello updated");
    });
});

// ── classifyReasoning ───────────────────────────────────────────────────────

describe("classifyReasoning", () => {
    it("UNSUPPORTED when field absent", () => {
        assert.equal(classifyReasoning({}).availability, ReasoningAvailability.UNSUPPORTED);
    });

    it("EMPTY when field is null", () => {
        assert.equal(
            classifyReasoning({ reasoningText: null }).availability,
            ReasoningAvailability.EMPTY,
        );
    });

    it("EMPTY when field is empty string", () => {
        assert.equal(
            classifyReasoning({ reasoningText: "" }).availability,
            ReasoningAvailability.EMPTY,
        );
    });

    it("AVAILABLE with text", () => {
        const result = classifyReasoning({ reasoningText: "thinking..." });
        assert.equal(result.availability, ReasoningAvailability.AVAILABLE);
        assert.equal(result.text, "thinking...");
    });
});

// ── resolveParent ───────────────────────────────────────────────────────────

describe("resolveParent", () => {
    it("returns parentToolCallId when present", () => {
        assert.equal(resolveParent({ parentToolCallId: "sa-1" }), "sa-1");
    });

    it("returns SYNTHETIC_ROOT_ID for null/undefined", () => {
        assert.equal(resolveParent({}), SYNTHETIC_ROOT_ID);
        assert.equal(resolveParent({ parentToolCallId: null }), SYNTHETIC_ROOT_ID);
        assert.equal(resolveParent(null), SYNTHETIC_ROOT_ID);
    });
});

// ── buildParentIndex ────────────────────────────────────────────────────────

describe("buildParentIndex", () => {
    it("groups tool calls by parentToolCallId", () => {
        const map = new Map();
        map.set("tc-1", createToolCallRecord("tc-1", { parentToolCallId: "sa-1" }));
        map.set("tc-2", createToolCallRecord("tc-2", { parentToolCallId: "sa-1" }));
        map.set("tc-3", createToolCallRecord("tc-3", { parentToolCallId: SYNTHETIC_ROOT_ID }));

        const idx = buildParentIndex(map);
        assert.equal(idx.get("sa-1").length, 2);
        assert.equal(idx.get(SYNTHETIC_ROOT_ID).length, 1);
    });
});

// ── buildTimeline ───────────────────────────────────────────────────────────

describe("buildTimeline", () => {
    it("returns entries sorted by origin timestamp", () => {
        const subs = new Map();
        subs.set("sa-1", createSubagentRecord("sa-1", { startedAt: "2025-01-01T00:02:00Z" }));

        const tcs = new Map();
        tcs.set("tc-1", createToolCallRecord("tc-1", { startedAt: "2025-01-01T00:01:00Z" }));

        const msgs = new Map();
        msgs.set("msg-1", createAssistantMessageRecord("msg-1", { timestamp: "2025-01-01T00:00:00Z" }));

        const timeline = buildTimeline(subs, tcs, msgs);
        assert.equal(timeline.length, 3);
        assert.equal(timeline[0].kind, "message");
        assert.equal(timeline[1].kind, "toolcall");
        assert.equal(timeline[2].kind, "subagent");
    });
});

// ── buildExecutionGraph ─────────────────────────────────────────────────────

describe("buildExecutionGraph", () => {
    it("builds a tree with synthetic root", () => {
        const subs = new Map();
        const tcs = new Map();
        const msgs = new Map();
        const graph = buildExecutionGraph(subs, tcs, msgs);
        assert.equal(graph.rootNodeKey, `root:${SYNTHETIC_ROOT_ID}`);
        assert.deepEqual(graph.orphanNodeKeys, []);
    });

    it("attaches subagent tool calls are hidden, subagent nodes visible", () => {
        const subs = new Map();
        subs.set("sa-1", createSubagentRecord("sa-1", { agentName: "explore" }));

        // The task tool call that spawned the subagent shares the same id
        const tcs = new Map();
        tcs.set("sa-1", createToolCallRecord("sa-1", {
            toolName: "task",
            parentToolCallId: SYNTHETIC_ROOT_ID,
        }));
        tcs.set("tc-child", createToolCallRecord("tc-child", {
            toolName: "grep",
            parentToolCallId: "sa-1",
        }));

        const msgs = new Map();
        const graph = buildExecutionGraph(subs, tcs, msgs);

        // sa-1 tool call should be hidden (replaced by subagent node)
        assert.ok(graph.hiddenToolCallIds.includes("sa-1"));
        // tc-child should be a child of the subagent node
        const saKey = "subagent:sa-1";
        assert.ok(graph.childNodeKeys[saKey]?.includes("toolcall:tc-child"));
    });
});
