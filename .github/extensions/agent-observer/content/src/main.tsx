/**
 * Agent Observer — hierarchy-first execution tree UI
 *
 * Read-only dashboard showing:
 *   - Overview cards (stats + subagent status)
 *   - Default execution tree / tree-table with real parent-child structure
 *   - Secondary flat timeline for raw chronology/debugging
 *   - Detail pane with lineage breadcrumbs for the selected node
 *
 * Data comes from the normalized event store via copilot.getSnapshot().
 * Auto-refreshes every 3 seconds while visible.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";

declare const copilot: {
    log: (msg: string, opts?: unknown) => Promise<void>;
    getSnapshot: () => Promise<string>;
};

interface SubagentRecord {
    id: string;
    agentName: string;
    agentDisplayName: string;
    agentDescription?: string;
    status: "started" | "completed" | "failed";
    startedAt?: string;
    completedAt?: string;
    failedAt?: string;
    error?: string;
    totalToolCalls?: number;
    totalTokens?: number;
    durationMs?: number;
    _lastEventTs: string;
}

interface ToolCallRecord {
    id: string;
    parentToolCallId: string;
    toolName: string;
    arguments?: unknown;
    status: "running" | "complete" | "failed";
    success?: boolean;
    resultPreview?: string;
    startedAt?: string;
    completedAt?: string;
    _lastEventTs: string;
}

interface AssistantMessageRecord {
    id: string;
    parentToolCallId: string;
    content: string;
    toolRequestCount: number;
    reasoningAvailability: "available" | "empty" | "unsupported";
    reasoningText?: string;
    timestamp: string;
    _lastEventTs: string;
}

interface Stats {
    subagentCount: number;
    toolCallCount: number;
    messageCount: number;
    ingestedEventCount: number;
    orphanToolCallCount: number;
}

interface TimelineRef {
    kind: "subagent" | "toolcall" | "message";
    id: string;
}

interface ExecutionGraphSnapshot {
    rootNodeKey: string;
    nodeParentKeys: Record<string, string | null>;
    childNodeKeys: Record<string, string[]>;
    pathNodeKeys: Record<string, string[]>;
    descendantCounts: Record<string, number>;
    orphanNodeKeys: string[];
    hiddenToolCallIds?: string[];
}

interface Snapshot {
    subagents: SubagentRecord[];
    toolCalls: ToolCallRecord[];
    messages: AssistantMessageRecord[];
    toolCallsByParent: Record<string, { toolCallId: string; toolName: string; status: string }[]>;
    executionGraph?: ExecutionGraphSnapshot;
    recentEvents: { ts: string; type: string; summary: string }[];
    timeline: TimelineRef[];
    stats: Stats;
}

interface FatalBoundaryState {
    error: string | null;
}

type Selection =
    | { kind: "root"; id: string }
    | { kind: "subagent"; id: string }
    | { kind: "toolcall"; id: string }
    | { kind: "message"; id: string }
    | null;

type ViewMode = "tree" | "timeline";
type StatusKey = "running" | "complete" | "failed";
type FilterKey =
    | "subagents"
    | "tools"
    | "messages"
    | "running"
    | "complete"
    | "failed"
    | "root";
type NodeKind = "root" | "subagent" | "toolcall" | "message";

interface FilterState {
    subagents: boolean;
    tools: boolean;
    messages: boolean;
    running: boolean;
    complete: boolean;
    failed: boolean;
    root: boolean;
}

interface ActivityItem {
    key: string;
    kind: "subagent" | "toolcall" | "message";
    id: string;
    ts: string;
    ownerId: string;
    ownerLabel: string;
    orphan: boolean;
    depth: number;
    pathKeys: string[];
    status: string;
    icon: string;
    kindLabel: string;
    title: string;
    subtitle: string;
    resultLine?: string;
    searchText: string;
}

interface ExecutionNode {
    key: string;
    kind: NodeKind;
    id: string;
    ts: string;
    status: string;
    icon: string;
    kindLabel: string;
    title: string;
    subtitle: string;
    searchText: string;
    parentKey: string | null;
    childKeys: string[];
    pathKeys: string[];
    descendantCount: number;
    orphan: boolean;
}

interface ActivityModel {
    items: ActivityItem[];
    nodesByKey: Map<string, ExecutionNode>;
    rootNodeKey: string;
    graph: ExecutionGraphSnapshot;
    subagentMap: Map<string, SubagentRecord>;
    toolCallMap: Map<string, ToolCallRecord>;
    messageMap: Map<string, AssistantMessageRecord>;
}

interface VisibleTreeNode {
    key: string;
    matched: boolean;
    children: VisibleTreeNode[];
}

interface DetailHeroPill {
    label: string;
    className?: string;
}

const SYNTHETIC_ROOT_ID = "__root__";
const UNAVAILABLE_FROM_EVENT_STREAM = "Unavailable from event stream";

function shortId(id: string): string {
    if (!id) return "—";
    if (id === SYNTHETIC_ROOT_ID) return "root";
    return id.length > 12 ? id.slice(0, 6) + "…" + id.slice(-4) : id;
}

function fmtTime(iso?: string): string {
    if (!iso) return "—";
    try {
        const d = new Date(iso);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
        return iso;
    }
}

function fmtDuration(ms?: number): string {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function statusIcon(status: string): string {
    switch (status) {
        case "started":
        case "running":
            return "⏳";
        case "completed":
        case "complete":
            return "✅";
        case "failed":
            return "❌";
        default:
            return "•";
    }
}

function statusClass(status: string): string {
    switch (status) {
        case "started":
        case "running":
            return "status-running";
        case "completed":
        case "complete":
            return "status-complete";
        case "failed":
            return "status-failed";
        default:
            return "";
    }
}

function normalizeStatus(status: string): StatusKey {
    if (status === "started" || status === "running") return "running";
    if (status === "failed") return "failed";
    return "complete";
}

function safeText(value: unknown): string {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim();
}

function previewText(value: string, limit: number): string {
    if (!value) return "(empty)";
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function shortPath(p: string): string {
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length <= 2) return p;
    return parts.slice(-2).join("/");
}

function tryParseJSON(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return null; }
}

function summarizeArgs(toolName: string, args: unknown): string {
    const parsed = tryParseJSON(args) ?? args;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const obj = parsed as Record<string, unknown>;
    const byTool: Record<string, { keys: string[]; transform?: (v: string, obj: Record<string, unknown>) => string }> = {
        grep:       { keys: ["pattern", "query"] },
        view:       { keys: ["path", "file"], transform: (v, o) => {
            const base = shortPath(v);
            const range = o["view_range"];
            if (Array.isArray(range) && range.length === 2) return `${base}:${range[0]}–${range[1]}`;
            return base;
        }},
        glob:       { keys: ["pattern", "path"], transform: (v) => shortPath(v) },
        powershell: { keys: ["command", "script"] },
        bash:       { keys: ["command", "script"] },
    };
    const spec = byTool[toolName.toLowerCase()];
    const keys = spec?.keys ?? [];
    for (const k of keys) {
        if (typeof obj[k] === "string" && obj[k]) {
            const raw = safeText(obj[k] as string);
            const display = spec?.transform ? spec.transform(raw, obj) : raw;
            return previewText(display, 100);
        }
    }
    // generic: first string value
    for (const v of Object.values(obj)) {
        if (typeof v === "string" && v.trim()) return previewText(safeText(v), 100);
    }
    return "";
}

function resultSnippet(toolName: string, resultPreview: string | undefined): string {
    if (!resultPreview) return "";
    const text = safeText(resultPreview);
    if (!text) return "";
    // Skip header-like lines (pure paths, counts, dashes) and return first meaningful line
    const lines = text.split("\n");
    const meaningful = lines.find((l) => {
        const t = l.trim();
        return t && !/^[-=]+$/.test(t) && !/^\d+ match/.test(t) && !/^No matches/.test(t);
    }) ?? lines.find((l) => l.trim()) ?? text;
    return previewText(meaningful, 120);
}

function ExpandablePre({ text, limit = 500, className = "detail-pre" }: { text: string; limit?: number; className?: string }) {
    const [expanded, setExpanded] = useState(false);
    const HARD_CEIL = 50_000;
    const display = expanded ? text.slice(0, HARD_CEIL) : text.slice(0, limit);
    const isTruncated = text.length > limit;
    const isHardCeiled = expanded && text.length > HARD_CEIL;
    return (
        <div className="expandable-pre-wrap">
            <pre className={className}>{display}{isHardCeiled ? "\n…(too large to display fully)" : ""}</pre>
            {isTruncated && (
                <button className="expandable-pre-toggle" onClick={() => setExpanded((v) => !v)}>
                    {expanded ? "Show less" : `Show more (${text.length.toLocaleString()} chars total)`}
                </button>
            )}
        </div>
    );
}

function compareIsoDesc(a?: string, b?: string): number {
    const aTime = a ? Date.parse(a) : 0;
    const bTime = b ? Date.parse(b) : 0;
    return bTime - aTime;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function selectionKey(selection: Selection): string | null {
    return selection ? `${selection.kind}:${selection.id}` : null;
}

function itemSelectionKey(item: ActivityItem): string {
    return `${item.kind}:${item.id}`;
}

function makeNodeKey(kind: NodeKind, id: string): string {
    return `${kind}:${id}`;
}

function parseNodeKey(key: string): { kind: NodeKind; id: string } {
    const index = key.indexOf(":");
    return {
        kind: (index === -1 ? key : key.slice(0, index)) as NodeKind,
        id: index === -1 ? "" : key.slice(index + 1),
    };
}

function renderFatal(message: string, detail?: unknown) {
    const root = document.getElementById("root");
    if (!root) return;

    const detailText =
        detail instanceof Error ? (detail.stack || detail.message) :
        typeof detail === "string" ? detail :
        detail != null ? JSON.stringify(detail, null, 2) :
        "";

    root.innerHTML = `
      <div class="fatal-screen">
        <div class="fatal-box">
          <div class="fatal-title">Agent Observer failed to render</div>
          <div class="fatal-text">${escapeHtml(message)}</div>
          ${detailText ? `<pre class="fatal-pre">${escapeHtml(detailText)}</pre>` : ""}
        </div>
      </div>
    `;
}

function stringifyForSearch(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function nodeOriginTimestamp(kind: NodeKind, id: string, snapshot: Snapshot): string {
    if (kind === "root") {
        return latestSnapshotTimestamp(snapshot);
    }
    if (kind === "subagent") {
        const record = snapshot.subagents.find((item) => item.id === id);
        return record?.startedAt || record?._lastEventTs || "";
    }
    if (kind === "toolcall") {
        const record = snapshot.toolCalls.find((item) => item.id === id);
        return record?.startedAt || record?.completedAt || record?._lastEventTs || "";
    }
    const record = snapshot.messages.find((item) => item.id === id);
    return record?.timestamp || record?._lastEventTs || "";
}

function latestSnapshotTimestamp(snapshot: Snapshot): string {
    return [
        ...snapshot.subagents.map((record) => record.completedAt || record.failedAt || record.startedAt || record._lastEventTs),
        ...snapshot.toolCalls.map((record) => record.completedAt || record.startedAt || record._lastEventTs),
        ...snapshot.messages.map((record) => record.timestamp || record._lastEventTs),
    ].sort(compareIsoDesc)[0] || "";
}

function buildFallbackExecutionGraph(snapshot: Snapshot): ExecutionGraphSnapshot {
    const rootNodeKey = makeNodeKey("root", SYNTHETIC_ROOT_ID);
    const childNodeKeys: Record<string, string[]> = { [rootNodeKey]: [] };
    const nodeParentKeys: Record<string, string | null> = { [rootNodeKey]: null };
    const hiddenToolCallIds = new Set(snapshot.subagents.map((record) => record.id));
    const subagentIds = new Set(snapshot.subagents.map((record) => record.id));
    const toolCallIds = new Set(snapshot.toolCalls.map((record) => record.id));
    const orphanKeys = new Set<string>();

    function ensureBucket(key: string): string[] {
        if (!childNodeKeys[key]) {
            childNodeKeys[key] = [];
        }
        return childNodeKeys[key];
    }

    function structuralParentKey(parentToolCallId?: string): string | null {
        if (!parentToolCallId || parentToolCallId === SYNTHETIC_ROOT_ID) return rootNodeKey;
        if (subagentIds.has(parentToolCallId)) return makeNodeKey("subagent", parentToolCallId);
        if (toolCallIds.has(parentToolCallId) && !hiddenToolCallIds.has(parentToolCallId)) {
            return makeNodeKey("toolcall", parentToolCallId);
        }
        return null;
    }

    function attach(kind: Exclude<NodeKind, "root">, id: string, parentToolCallId?: string) {
        const key = makeNodeKey(kind, id);
        let parentKey = structuralParentKey(parentToolCallId);
        if (!parentKey) {
            parentKey = rootNodeKey;
            if (parentToolCallId && parentToolCallId !== SYNTHETIC_ROOT_ID) {
                orphanKeys.add(key);
            }
        }
        nodeParentKeys[key] = parentKey;
        ensureBucket(parentKey).push(key);
        ensureBucket(key);
    }

    for (const record of snapshot.subagents) {
        const sourceTool = snapshot.toolCalls.find((tool) => tool.id === record.id);
        attach("subagent", record.id, sourceTool?.parentToolCallId);
    }
    for (const record of snapshot.toolCalls) {
        if (hiddenToolCallIds.has(record.id)) continue;
        attach("toolcall", record.id, record.parentToolCallId);
    }
    for (const record of snapshot.messages) {
        attach("message", record.id, record.parentToolCallId);
    }

    for (const key of Object.keys(childNodeKeys)) {
        childNodeKeys[key].sort((a, b) => {
            const aRef = parseNodeKey(a);
            const bRef = parseNodeKey(b);
            return compareIsoDesc(
                nodeOriginTimestamp(aRef.kind, aRef.id, snapshot),
                nodeOriginTimestamp(bRef.kind, bRef.id, snapshot),
            ) || a.localeCompare(b);
        });
    }

    const pathNodeKeys: Record<string, string[]> = { [rootNodeKey]: [rootNodeKey] };
    const descendantCounts: Record<string, number> = {};

    function resolvePath(key: string, seen = new Set<string>()): string[] {
        if (pathNodeKeys[key]) return pathNodeKeys[key];
        if (seen.has(key)) {
            orphanKeys.add(key);
            return [rootNodeKey, key];
        }
        seen.add(key);
        const parentKey = nodeParentKeys[key] || rootNodeKey;
        const path = [...resolvePath(parentKey, seen), key];
        pathNodeKeys[key] = path;
        seen.delete(key);
        return path;
    }

    function countDescendants(key: string, seen = new Set<string>()): number {
        if (key in descendantCounts) return descendantCounts[key];
        if (seen.has(key)) return 0;
        seen.add(key);
        let total = 0;
        for (const childKey of childNodeKeys[key] || []) {
            total += 1 + countDescendants(childKey, seen);
        }
        seen.delete(key);
        descendantCounts[key] = total;
        return total;
    }

    for (const key of Object.keys(nodeParentKeys)) {
        resolvePath(key);
        countDescendants(key);
    }

    return {
        rootNodeKey,
        nodeParentKeys,
        childNodeKeys,
        pathNodeKeys,
        descendantCounts,
        orphanNodeKeys: [...orphanKeys],
        hiddenToolCallIds: [...hiddenToolCallIds],
    };
}

function getNodeTitleByKey(nodesByKey: Map<string, ExecutionNode>, key: string | null | undefined): string {
    if (!key) return "Root session";
    return nodesByKey.get(key)?.title || shortId(parseNodeKey(key).id);
}

function pluralize(count: number, noun: string, plural = `${noun}s`): string {
    return `${count} ${count === 1 ? noun : plural}`;
}

function titleCase(value: string): string {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function extractNamedText(value: unknown, keys: string[], depth = 0): string | null {
    if (depth > 4 || value == null) return null;
    if (typeof value === "string") {
        const text = value.trim();
        return text ? text : null;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = extractNamedText(item, keys, depth + 1);
            if (found) return found;
        }
        return null;
    }
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        for (const key of keys) {
            if (key in record) {
                const found = extractNamedText(record[key], keys, depth + 1);
                if (found) return found;
            }
        }
    }
    return null;
}

function toPromptBlock(value: string, maxLines = 10): string {
    const lines = value.split(/\r?\n/);
    const shown = lines.slice(0, maxLines).join("\n");
    return lines.length > maxLines ? `${shown}\n…` : shown;
}

function inferDurationMsForNode(model: ActivityModel, node: ExecutionNode): number | undefined {
    if (node.kind === "subagent") {
        const record = model.subagentMap.get(node.id);
        if (!record) return undefined;
        if (record.durationMs != null) return record.durationMs;
        const start = record.startedAt ? Date.parse(record.startedAt) : NaN;
        const endSource = record.completedAt || record.failedAt;
        const end = endSource ? Date.parse(endSource) : (record.status === "started" ? Date.now() : NaN);
        if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
            return end - start;
        }
        return undefined;
    }
    if (node.kind === "toolcall") {
        const record = model.toolCallMap.get(node.id);
        if (!record) return undefined;
        const start = record.startedAt ? Date.parse(record.startedAt) : NaN;
        const endSource = record.completedAt;
        const end = endSource ? Date.parse(endSource) : (record.status === "running" ? Date.now() : NaN);
        if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
            return end - start;
        }
    }
    return undefined;
}

function formatNodeStatusSummary(model: ActivityModel, node: ExecutionNode): string {
    if (node.kind === "root") return "Active";
    const raw = normalizeStatus(node.status);
    const label = titleCase(raw);
    const durationMs = inferDurationMsForNode(model, node);
    return durationMs != null ? `${label} (${fmtDuration(durationMs)})` : label;
}

function formatToolRecordStatusSummary(record: ToolCallRecord): string {
    const label = titleCase(normalizeStatus(record.status));
    const start = record.startedAt ? Date.parse(record.startedAt) : NaN;
    const end = record.completedAt ? Date.parse(record.completedAt) : (record.status === "running" ? Date.now() : NaN);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
        return `${label} (${fmtDuration(end - start)})`;
    }
    return label;
}

function getNodeTypeLabel(model: ActivityModel, node: ExecutionNode): string {
    if (node.kind === "root") return "root";
    if (node.kind === "subagent") {
        return model.subagentMap.get(node.id)?.agentName || "subagent";
    }
    if (node.kind === "toolcall") return "tool";
    return "assistant.message";
}

function getNodeDescription(model: ActivityModel, node: ExecutionNode): string {
    if (node.kind === "root") return "Foreground session + orphan activity";
    if (node.kind === "subagent") {
        const record = model.subagentMap.get(node.id);
        return record?.agentDescription || node.subtitle || UNAVAILABLE_FROM_EVENT_STREAM;
    }
    if (node.kind === "toolcall") {
        const record = model.toolCallMap.get(node.id);
        return record?.toolName || node.subtitle || UNAVAILABLE_FROM_EVENT_STREAM;
    }
    const record = model.messageMap.get(node.id);
    const content = safeText(record?.content ?? "");
    return content ? previewText(content, 140) : "Assistant message";
}

function getNodeModelLabel(model: ActivityModel, node: ExecutionNode): string {
    if (node.kind === "root" || node.kind === "message") return UNAVAILABLE_FROM_EVENT_STREAM;
    const keys = ["model", "modelName", "overrideModel", "override_model"];
    const ownArgs = model.toolCallMap.get(node.id)?.arguments;
    const ownModel = extractNamedText(ownArgs, keys);
    if (ownModel) return previewText(safeText(ownModel), 80);
    if (node.kind === "subagent") {
        const descendantTool = collectDescendantNodes(model, node.key).find((candidate) => candidate.kind === "toolcall");
        const descendantModel = descendantTool
            ? extractNamedText(model.toolCallMap.get(descendantTool.id)?.arguments, keys)
            : null;
        if (descendantModel) return previewText(safeText(descendantModel), 80);
    }
    return UNAVAILABLE_FROM_EVENT_STREAM;
}

function getNodePromptText(model: ActivityModel, node: ExecutionNode): string {
    if (node.kind === "root") return UNAVAILABLE_FROM_EVENT_STREAM;
    if (node.kind === "message") {
        const record = model.messageMap.get(node.id);
        const content = safeText(record?.content ?? "");
        return content ? toPromptBlock(content) : UNAVAILABLE_FROM_EVENT_STREAM;
    }

    const ownArgs = model.toolCallMap.get(node.id)?.arguments;
    const ownPrompt = extractNamedText(ownArgs, ["prompt", "description", "task", "goal", "query", "message", "content", "input", "request"]);
    if (ownPrompt) return toPromptBlock(ownPrompt);

    const descendants = collectDescendantNodes(model, node.key);
    const descendantPromptNode = descendants
        .slice()
        .sort((a, b) => compareIsoDesc(a.ts, b.ts))
        .find((candidate) => candidate.kind === "toolcall" || candidate.kind === "message");
    if (descendantPromptNode?.kind === "toolcall") {
        const prompt = extractNamedText(model.toolCallMap.get(descendantPromptNode.id)?.arguments, ["prompt", "description", "task", "goal", "query", "message", "content", "input", "request"]);
        if (prompt) return toPromptBlock(prompt);
    }
    if (descendantPromptNode?.kind === "message") {
        const content = safeText(model.messageMap.get(descendantPromptNode.id)?.content ?? "");
        if (content) return toPromptBlock(content);
    }
    return UNAVAILABLE_FROM_EVENT_STREAM;
}

function getRecentActivityNodes(model: ActivityModel, node: ExecutionNode, limit = 8): ExecutionNode[] {
    if (node.kind === "message") return [];
    return collectDescendantNodes(model, node.key)
        .slice()
        .sort((a, b) => compareIsoDesc(a.ts, b.ts))
        .slice(0, limit);
}

function getRecentActivityPreview(model: ActivityModel, node: ExecutionNode): string {
    const recent = getRecentActivityNodes(model, node, 1)[0];
    if (!recent) return "No recent activity yet";
    return recent.subtitle ? `${recent.title} — ${recent.subtitle}` : recent.title;
}

function resolveOwnerFromPath(
    nodesByKey: Map<string, ExecutionNode>,
    pathKeys: string[],
): { ownerId: string; ownerLabel: string } {
    for (let index = pathKeys.length - 2; index >= 0; index--) {
        const node = nodesByKey.get(pathKeys[index]);
        if (!node) continue;
        if (node.kind === "subagent") {
            return { ownerId: node.id, ownerLabel: node.title };
        }
    }
    return { ownerId: SYNTHETIC_ROOT_ID, ownerLabel: "Root session" };
}

function buildActivityModel(snapshot: Snapshot): ActivityModel {
    const subagentMap = new Map(snapshot.subagents.map((record) => [record.id, record]));
    const toolCallMap = new Map(snapshot.toolCalls.map((record) => [record.id, record]));
    const messageMap = new Map(snapshot.messages.map((record) => [record.id, record]));

    // Build message → [toolName, ...] mapping by scanning timeline in order.
    // Tool calls that share the same parent and appear after a message (and before
    // the next sibling message) were spawned by that message.
    const messageToolNames = new Map<string, string[]>();
    {
        let lastMsgId: string | null = null;
        let lastMsgParent: string | null = null;
        for (const ref of snapshot.timeline) {
            if (ref.kind === "message") {
                lastMsgId = ref.id;
                lastMsgParent = messageMap.get(ref.id)?.parentToolCallId ?? null;
            } else if (ref.kind === "toolcall" && lastMsgId) {
                const tc = toolCallMap.get(ref.id);
                if (tc && tc.parentToolCallId === lastMsgParent) {
                    if (!messageToolNames.has(lastMsgId)) messageToolNames.set(lastMsgId, []);
                    messageToolNames.get(lastMsgId)!.push(tc.toolName);
                }
            }
        }
    }
    const graph = snapshot.executionGraph ?? buildFallbackExecutionGraph(snapshot);
    const rootNodeKey = graph.rootNodeKey || makeNodeKey("root", SYNTHETIC_ROOT_ID);
    const hiddenToolCallIds = new Set(graph.hiddenToolCallIds ?? []);
    const orphanKeys = new Set(graph.orphanNodeKeys ?? []);
    const nodesByKey = new Map<string, ExecutionNode>();

    nodesByKey.set(rootNodeKey, {
        key: rootNodeKey,
        kind: "root",
        id: SYNTHETIC_ROOT_ID,
        ts: latestSnapshotTimestamp(snapshot),
        status: "complete",
        icon: "🧭",
        kindLabel: "root",
        title: "Root session",
        subtitle: "Foreground session + orphan activity",
        searchText: "root session orphan foreground",
        parentKey: null,
        childKeys: graph.childNodeKeys[rootNodeKey] ?? [],
        pathKeys: graph.pathNodeKeys[rootNodeKey] ?? [rootNodeKey],
        descendantCount: graph.descendantCounts[rootNodeKey] ?? 0,
        orphan: false,
    });

    for (const record of snapshot.subagents) {
        const key = makeNodeKey("subagent", record.id);
        const title = record.agentDisplayName || record.agentName || shortId(record.id);
        nodesByKey.set(key, {
            key,
            kind: "subagent",
            id: record.id,
            ts: record.startedAt || record._lastEventTs,
            status: record.status,
            icon: statusIcon(record.status),
            kindLabel: "agent",
            title,
            subtitle: [
                record.agentName || "subagent",
                record.totalToolCalls != null ? `${record.totalToolCalls} tools` : "",
                record.durationMs != null ? fmtDuration(record.durationMs) : "",
            ].filter(Boolean).join(" · "),
            searchText: `${title} ${record.agentName} ${record.agentDescription ?? ""}`.toLowerCase(),
            parentKey: graph.nodeParentKeys[key] ?? rootNodeKey,
            childKeys: graph.childNodeKeys[key] ?? [],
            pathKeys: graph.pathNodeKeys[key] ?? [rootNodeKey, key],
            descendantCount: graph.descendantCounts[key] ?? 0,
            orphan: orphanKeys.has(key),
        });
    }

    for (const record of snapshot.toolCalls) {
        if (hiddenToolCallIds.has(record.id)) continue;
        const key = makeNodeKey("toolcall", record.id);
        const title = record.toolName || shortId(record.id);
        nodesByKey.set(key, {
            key,
            kind: "toolcall",
            id: record.id,
            ts: record.startedAt || record.completedAt || record._lastEventTs,
            status: record.status,
            icon: statusIcon(record.status),
            kindLabel: "tool",
            title,
            subtitle: [
                summarizeArgs(record.toolName, record.arguments) ||
                (record.resultPreview ? previewText(safeText(record.resultPreview), 80) : ""),
            ].filter(Boolean).join(" · "),
            searchText: `${title} ${stringifyForSearch(record.arguments)} ${record.resultPreview ?? ""}`.toLowerCase(),
            parentKey: graph.nodeParentKeys[key] ?? rootNodeKey,
            childKeys: graph.childNodeKeys[key] ?? [],
            pathKeys: graph.pathNodeKeys[key] ?? [rootNodeKey, key],
            descendantCount: graph.descendantCounts[key] ?? 0,
            orphan: orphanKeys.has(key),
        });
    }

    for (const record of snapshot.messages) {
        const key = makeNodeKey("message", record.id);
        const content = safeText(record.content);
        const toolNames = messageToolNames.get(record.id) ?? [];
        const displayTitle = content
            ? previewText(content, 200)
            : toolNames.length > 0
                ? `→ ${toolNames.slice(0, 4).join(", ")}${toolNames.length > 4 ? ` (+${toolNames.length - 4})` : ""}`
                : "(empty)";
        nodesByKey.set(key, {
            key,
            kind: "message",
            id: record.id,
            ts: record.timestamp || record._lastEventTs,
            status: "complete",
            icon: "💬",
            kindLabel: "msg",
            title: displayTitle,
            subtitle: record.toolRequestCount > 0 ? `${record.toolRequestCount} tool req${record.toolRequestCount === 1 ? "" : "s"}` : "",
            searchText: `${content} ${record.reasoningText ?? ""}`.toLowerCase(),
            parentKey: graph.nodeParentKeys[key] ?? rootNodeKey,
            childKeys: graph.childNodeKeys[key] ?? [],
            pathKeys: graph.pathNodeKeys[key] ?? [rootNodeKey, key],
            descendantCount: graph.descendantCounts[key] ?? 0,
            orphan: orphanKeys.has(key),
        });
    }

    const items: ActivityItem[] = [];

    for (const ref of [...snapshot.timeline].reverse()) {
        if (ref.kind === "subagent") {
            const record = subagentMap.get(ref.id);
            const node = nodesByKey.get(makeNodeKey("subagent", ref.id));
            if (!record || !node) continue;
            const owner = resolveOwnerFromPath(nodesByKey, node.pathKeys);
            items.push({
                key: `${ref.kind}:${record.id}`,
                kind: "subagent",
                id: record.id,
                ts: node.ts,
                ownerId: owner.ownerId,
                ownerLabel: owner.ownerLabel,
                orphan: node.orphan,
                depth: Math.max(0, node.pathKeys.length - 2),
                pathKeys: node.pathKeys,
                status: record.status,
                icon: statusIcon(record.status),
                kindLabel: "agent",
                title: node.title,
                subtitle: node.subtitle,
                searchText: node.searchText,
            });
            continue;
        }

        if (ref.kind === "toolcall") {
            const record = toolCallMap.get(ref.id);
            if (!record) continue;
            const structuralNode = nodesByKey.get(makeNodeKey("toolcall", ref.id))
                || nodesByKey.get(makeNodeKey("subagent", ref.id));
            const pathKeys = structuralNode?.pathKeys ?? [rootNodeKey];
            const owner = resolveOwnerFromPath(nodesByKey, pathKeys);
            const orphan = structuralNode?.orphan ?? false;
            items.push({
                key: `${ref.kind}:${record.id}`,
                kind: "toolcall",
                id: record.id,
                ts: record.startedAt || record.completedAt || record._lastEventTs,
                ownerId: owner.ownerId,
                ownerLabel: owner.ownerLabel,
                orphan,
                depth: Math.max(0, pathKeys.length - 2),
                pathKeys,
                status: record.status,
                icon: statusIcon(record.status),
                kindLabel: "tool",
                title: record.toolName || shortId(record.id),
                subtitle: summarizeArgs(record.toolName, record.arguments) ||
                    (record.resultPreview ? previewText(safeText(record.resultPreview), 100) : ""),
                resultLine: summarizeArgs(record.toolName, record.arguments)
                    ? resultSnippet(record.toolName, record.resultPreview)
                    : "",
                searchText: `${record.toolName} ${stringifyForSearch(record.arguments)} ${record.resultPreview ?? ""}`.toLowerCase(),
            });
            continue;
        }

        const record = messageMap.get(ref.id);
        const node = nodesByKey.get(makeNodeKey("message", ref.id));
        if (!record || !node) continue;
        const owner = resolveOwnerFromPath(nodesByKey, node.pathKeys);
        items.push({
            key: `${ref.kind}:${record.id}`,
            kind: "message",
            id: record.id,
            ts: node.ts,
            ownerId: owner.ownerId,
            ownerLabel: owner.ownerLabel,
            orphan: node.orphan,
            depth: Math.max(0, node.pathKeys.length - 2),
            pathKeys: node.pathKeys,
            status: "complete",
            icon: "💬",
            kindLabel: "msg",
            title: node.title,
            subtitle: node.subtitle,
            searchText: node.searchText,
        });
    }

    return { items, nodesByKey, rootNodeKey, graph, subagentMap, toolCallMap, messageMap };
}

function selectionToStructuralNodeKey(selection: Selection, model: ActivityModel): string | null {
    if (!selection) return null;
    if (selection.kind === "root") return model.rootNodeKey;

    const directKey = makeNodeKey(selection.kind, selection.id);
    if (model.nodesByKey.has(directKey)) return directKey;

    const mirroredSubagentKey = makeNodeKey("subagent", selection.id);
    if (model.nodesByKey.has(mirroredSubagentKey)) return mirroredSubagentKey;

    return null;
}

function matchesItemFilters(item: ActivityItem, filters: FilterState, query: string): boolean {
    if (item.kind === "subagent" && !filters.subagents) return false;
    if (item.kind === "toolcall" && !filters.tools) return false;
    if (item.kind === "message" && !filters.messages) return false;
    if (item.kind !== "message" && !filters[normalizeStatus(item.status)]) return false;
    if (!filters.root && (item.orphan || (item.kind !== "subagent" && item.ownerId === SYNTHETIC_ROOT_ID))) return false;
    if (!query) return true;
    return item.searchText.includes(query) || item.ownerLabel.toLowerCase().includes(query);
}

function matchesNodeFilters(node: ExecutionNode, filters: FilterState, query: string): boolean {
    if (node.kind === "subagent" && !filters.subagents) return false;
    if (node.kind === "toolcall" && !filters.tools) return false;
    if (node.kind === "message" && !filters.messages) return false;
    if (node.kind !== "root" && node.kind !== "message" && !filters[normalizeStatus(node.status)]) return false;
    if (!query) return true;
    return node.searchText.includes(query) || node.title.toLowerCase().includes(query);
}

function buildVisibleTree(
    model: ActivityModel,
    nodeKey: string,
    filters: FilterState,
    query: string,
    hideRootContext = false,
): VisibleTreeNode | null {
    const node = model.nodesByKey.get(nodeKey);
    if (!node) return null;

    const blockedByRootContext = hideRootContext || (
        !filters.root
        && node.kind !== "root"
        && (node.orphan || (node.parentKey === model.rootNodeKey && node.kind !== "subagent"))
    );

    if (blockedByRootContext) {
        return null;
    }

    const children = node.childKeys
        .map((childKey) => buildVisibleTree(model, childKey, filters, query, blockedByRootContext))
        .filter((child): child is VisibleTreeNode => child != null);

    const matched = node.kind === "root"
        ? true
        : matchesNodeFilters(node, filters, query);

    if (node.kind === "root" || matched || children.length > 0) {
        return { key: nodeKey, matched, children };
    }

    return null;
}

function collectDescendantNodes(model: ActivityModel, nodeKey: string): ExecutionNode[] {
    const descendants: ExecutionNode[] = [];

    function walk(currentKey: string) {
        const current = model.nodesByKey.get(currentKey);
        if (!current) return;
        for (const childKey of current.childKeys) {
            const child = model.nodesByKey.get(childKey);
            if (!child) continue;
            descendants.push(child);
            walk(childKey);
        }
    }

    walk(nodeKey);
    return descendants;
}

function selectionForNode(node: ExecutionNode): Selection {
    if (node.kind === "root") {
        return { kind: "root", id: SYNTHETIC_ROOT_ID };
    }
    return { kind: node.kind, id: node.id };
}

function selectionExists(selection: Selection, model: ActivityModel | null): boolean {
    if (!selection || !model) return true;
    return selectionToStructuralNodeKey(selection, model) != null;
}

class FatalBoundary extends React.Component<React.PropsWithChildren, FatalBoundaryState> {
    constructor(props: React.PropsWithChildren) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error: Error): FatalBoundaryState {
        return { error: error?.stack || error?.message || String(error) };
    }

    componentDidCatch(error: Error) {
        console.error("Agent Observer render failed", error);
    }

    render() {
        if (this.state.error) {
            return (
                <div className="fatal-screen">
                    <div className="fatal-box">
                        <div className="fatal-title">Agent Observer failed to render</div>
                        <div className="fatal-text">React hit a runtime error while rendering the UI.</div>
                        <pre className="fatal-pre">{this.state.error}</pre>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}

function OverviewCards({ stats, subagents }: { stats: Stats; subagents: SubagentRecord[] }) {
    const running = subagents.filter((subagent) => subagent.status === "started").length;
    const completed = subagents.filter((subagent) => subagent.status === "completed").length;
    const failed = subagents.filter((subagent) => subagent.status === "failed").length;

    return (
        <section className="overview">
            <div className="card">
                <div className="card-value">{stats.subagentCount}</div>
                <div className="card-label">Background Subagents</div>
                {stats.subagentCount > 0 && (
                    <div className="card-detail">
                        {running > 0 && <span className="status-running">⏳{running}</span>}
                        {completed > 0 && <span className="status-complete">✅{completed}</span>}
                        {failed > 0 && <span className="status-failed">❌{failed}</span>}
                    </div>
                )}
            </div>
            <div className="card">
                <div className="card-value">{stats.toolCallCount}</div>
                <div className="card-label">Tool Calls</div>
                {stats.orphanToolCallCount > 0 && (
                    <div className="card-detail">{stats.orphanToolCallCount} orphan</div>
                )}
            </div>
            <div className="card">
                <div className="card-value">{stats.messageCount}</div>
                <div className="card-label">Messages</div>
            </div>
            <div className="card">
                <div className="card-value">{stats.ingestedEventCount}</div>
                <div className="card-label">Events Ingested</div>
            </div>
        </section>
    );
}

function EventRow({
    item,
    selection,
    onSelect,
    showOwner,
}: {
    item: ActivityItem;
    selection: Selection;
    onSelect: (selection: Selection) => void;
    showOwner: boolean;
}) {
    const isSelected = selectionKey(selection) === itemSelectionKey(item);
    const paddingLeft = 12 + (item.depth * 18);

    return (
        <button
            type="button"
            className={`event-row ${isSelected ? "selected" : ""} kind-${item.kind}`}
            style={{ paddingLeft: `${paddingLeft}px` }}
            onClick={() => onSelect({ kind: item.kind, id: item.id })}
            title={item.title}
        >
            <span className={`activity-icon ${statusClass(item.status)}`}>{item.icon}</span>
            <span className="event-main">
                <span className="event-title">{item.title}</span>
                {item.subtitle && <span className="event-subtitle">{item.subtitle}</span>}
                {item.resultLine && <span className="event-result-line">{item.resultLine}</span>}
            </span>
            <span className={`kind-pill kind-pill-${item.kind}`}>{item.kindLabel}</span>
            {item.orphan && <span className="owner-pill owner-pill-orphan">orphan</span>}
            {showOwner && <span className="owner-pill">{item.ownerLabel}</span>}
            <span className="activity-ts">{fmtTime(item.ts)}</span>
        </button>
    );
}

function TreeBranch({
    branch,
    model,
    selectedNodeKey,
    selectedPath,
    collapsed,
    onToggle,
    onSelect,
    query,
}: {
    branch: VisibleTreeNode;
    model: ActivityModel;
    selectedNodeKey: string | null;
    selectedPath: Set<string>;
    collapsed: Record<string, boolean>;
    onToggle: (key: string, nextCollapsed: boolean) => void;
    onSelect: (selection: Selection) => void;
    query: string;
}) {
    const node = model.nodesByKey.get(branch.key);
    if (!node) return null;
    const showSelf = node.kind === "root" || branch.matched;

    const isSelected = selectedNodeKey === node.key;
    const inSelectedPath = !isSelected && selectedPath.has(node.key);
    const isTopLevelBranch = node.parentKey === model.rootNodeKey && node.kind !== "root";
    const hasChildren = branch.children.length > 0;
    const defaultCollapsed = node.kind === "root" ? false : true;
    const explicitCollapsed = collapsed[node.key];
    const isExpanded = query
        ? true
        : explicitCollapsed != null
            ? !explicitCollapsed
            : selectedPath.has(node.key)
            ? true
            : !defaultCollapsed;
    const depthGuides = Math.max(0, node.pathKeys.length - 2);
    const nodeDescription = getNodeDescription(model, node);
    const disambiguator = isTopLevelBranch
        ? (() => {
            const modelLabel = getNodeModelLabel(model, node);
            return modelLabel !== UNAVAILABLE_FROM_EVENT_STREAM ? `Model: ${modelLabel}` : `ID: ${shortId(node.id)}`;
        })()
        : null;
    const recentPreview = isTopLevelBranch ? getRecentActivityPreview(model, node) : null;
    const visibleChildren = node.kind === "root" && !query
        ? branch.children.filter((child) => {
            const childNode = model.nodesByKey.get(child.key);
            if (!childNode) return false;
            return selectedPath.has(child.key) || childNode.kind === "subagent" || childNode.childKeys.length > 0 || childNode.orphan;
        })
        : branch.children;

    if (!showSelf) {
        if (visibleChildren.length === 0) return null;
        return (
            <div className="tree-children tree-children-promoted">
                {visibleChildren.map((child) => (
                    <TreeBranch
                        key={child.key}
                        branch={child}
                        model={model}
                        selectedNodeKey={selectedNodeKey}
                        selectedPath={selectedPath}
                        collapsed={collapsed}
                        onToggle={onToggle}
                        onSelect={onSelect}
                        query={query}
                    />
                ))}
            </div>
        );
    }

    return (
        <div className={`tree-branch ${node.kind === "root" ? "tree-branch-root" : ""}`}>
            <div className={`tree-row ${isSelected ? "selected" : ""} ${inSelectedPath ? "selected-ancestor" : ""} ${isTopLevelBranch ? "tree-row-top-level" : ""}`}>
                <div className="tree-row-main">
                    <div className="tree-guides" aria-hidden="true">
                        {Array.from({ length: depthGuides }).map((_, index) => {
                            const ancestorKey = node.pathKeys[index + 1];
                            return (
                                <span
                                    key={`${node.key}-guide-${ancestorKey}-${index}`}
                                    className={`tree-guide ${selectedPath.has(ancestorKey) ? "active" : ""}`}
                                />
                            );
                        })}
                    </div>
                    {hasChildren ? (
                        <button
                            type="button"
                            className="tree-toggle"
                            onClick={() => onToggle(node.key, isExpanded)}
                            aria-label={isExpanded ? "Collapse subtree" : "Expand subtree"}
                        >
                            {isExpanded ? "▾" : "▸"}
                        </button>
                    ) : (
                        <span className="tree-toggle-spacer" />
                    )}

                        <button
                            type="button"
                            className="tree-select"
                            onClick={() => onSelect(selectionForNode(node))}
                            title={node.title}
                        >
                        <span className={`activity-icon ${statusClass(node.status)}`}>{node.icon}</span>
                        <span className={`tree-title-wrap ${isTopLevelBranch ? "tree-title-wrap-top-level" : ""}`}>
                            <span className="tree-title">{node.title}</span>
                            {(isTopLevelBranch ? nodeDescription : node.subtitle) && (
                                <span className="tree-subtitle">{isTopLevelBranch ? nodeDescription : node.subtitle}</span>
                            )}
                            {isTopLevelBranch && (
                                <span className="tree-summary-line">
                                    <span className="tree-summary-primary">Recent: {recentPreview}</span>
                                    <span className="tree-summary-divider">•</span>
                                    <span className="tree-summary-secondary">{disambiguator}</span>
                                </span>
                            )}
                        </span>
                    </button>
                </div>

                <div className="tree-row-meta">
                    {!isTopLevelBranch && <span className="tree-meta-text tree-meta-kind">{getNodeTypeLabel(model, node)}</span>}
                    <span className={`tree-meta-text tree-meta-status ${statusClass(node.status)}`}>{formatNodeStatusSummary(model, node)}</span>
                    {node.orphan && <span className="tree-meta-text tree-meta-warn">orphan</span>}
                </div>

                <div className="tree-row-time">{fmtTime(node.ts)}</div>
            </div>

            {visibleChildren.length > 0 && isExpanded && (
                <div className="tree-children">
                    {visibleChildren.map((child) => (
                        <TreeBranch
                            key={child.key}
                            branch={child}
                            model={model}
                            selectedNodeKey={selectedNodeKey}
                            selectedPath={selectedPath}
                            collapsed={collapsed}
                            onToggle={onToggle}
                            onSelect={onSelect}
                            query={query}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function ExecutionTreeView({
    model,
    visibleTree,
    query,
    selection,
    onSelect,
}: {
    model: ActivityModel;
    visibleTree: VisibleTreeNode | null;
    query: string;
    selection: Selection;
    onSelect: (selection: Selection) => void;
}) {
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const selectedNodeKey = useMemo(
        () => selectionToStructuralNodeKey(selection, model),
        [selection, model],
    );
    const selectedPath = useMemo(
        () => new Set(selectedNodeKey ? model.nodesByKey.get(selectedNodeKey)?.pathKeys ?? [] : []),
        [selectedNodeKey, model],
    );

    const toggleNode = useCallback((key: string, nextCollapsed: boolean) => {
        setCollapsed((current) => ({ ...current, [key]: nextCollapsed }));
    }, []);

    if (!visibleTree) {
        return <div className="activity-empty">No tree nodes match the current filters.</div>;
    }

    return (
        <div className="tree-list">
                <div className="tree-head">
                <div className="tree-head-cell">Background activity</div>
                <div className="tree-head-cell tree-head-meta">Status</div>
                <div className="tree-head-cell tree-head-time">Updated</div>
            </div>

            <TreeBranch
                branch={visibleTree}
                model={model}
                selectedNodeKey={selectedNodeKey}
                selectedPath={selectedPath}
                collapsed={collapsed}
                onToggle={toggleNode}
                onSelect={onSelect}
                query={query}
            />
        </div>
    );
}

function FlatTimelineView({
    items,
    filters,
    query,
    selection,
    onSelect,
}: {
    items: ActivityItem[];
    filters: FilterState;
    query: string;
    selection: Selection;
    onSelect: (selection: Selection) => void;
}) {
    const visible = useMemo(
        () => items.filter((item) => matchesItemFilters(item, filters, query)),
        [filters, items, query],
    );

    if (visible.length === 0) {
        return <div className="activity-empty">No chronological matches for current filters.</div>;
    }

    return (
        <div className="flat-list">
            {visible.map((item) => (
                <EventRow
                    key={item.key}
                    item={item}
                    selection={selection}
                    onSelect={onSelect}
                    showOwner={true}
                />
            ))}
        </div>
    );
}

function FilterButton({
    active,
    label,
    onClick,
}: {
    active: boolean;
    label: string;
    onClick: () => void;
}) {
    return (
        <button type="button" className={`filter-chip ${active ? "active" : ""}`} onClick={onClick}>
            {label}
        </button>
    );
}

/* ── Agent Hierarchy Panel ──────────────────────────────────────────────── */

interface HierarchyAgentNode {
    key: string;
    node: ExecutionNode;
    record: SubagentRecord | null;
    children: HierarchyAgentNode[];
    depth: number;
    recentPreview: string;
}

function buildAgentHierarchy(
    model: ActivityModel,
    filters: FilterState,
    query: string,
): HierarchyAgentNode | null {
    const rootNode = model.nodesByKey.get(model.rootNodeKey);
    if (!rootNode) return null;

    const lowerQuery = query.toLowerCase();

    function matchesQuery(node: ExecutionNode, record: SubagentRecord | null): boolean {
        if (!lowerQuery) return true;
        const name = record?.agentDisplayName || record?.agentName || "";
        return (
            node.searchText.includes(lowerQuery) ||
            name.toLowerCase().includes(lowerQuery)
        );
    }

    function matchesStatusFilter(node: ExecutionNode): boolean {
        if (node.kind === "root") return true;
        return filters[normalizeStatus(node.status)];
    }

    function walkAgents(nodeKey: string, depth: number): HierarchyAgentNode | null {
        const node = model.nodesByKey.get(nodeKey);
        if (!node) return null;
        if (node.kind !== "root" && node.kind !== "subagent") return null;

        const record = node.kind === "subagent" ? (model.subagentMap.get(node.id) ?? null) : null;

        // Recurse into all children looking for agent nodes
        const agentChildren: HierarchyAgentNode[] = [];
        for (const childKey of node.childKeys) {
            const childNode = model.nodesByKey.get(childKey);
            if (!childNode) continue;
            if (childNode.kind === "subagent") {
                const childResult = walkAgents(childKey, depth + 1);
                if (childResult) agentChildren.push(childResult);
            } else {
                // Walk deeper — agents can be nested under non-agent nodes
                for (const grandchildKey of childNode.childKeys) {
                    const found = walkAgentsDeep(grandchildKey, depth + 1);
                    agentChildren.push(...found);
                }
            }
        }

        const selfMatchesQuery = matchesQuery(node, record);
        const selfMatchesStatus = matchesStatusFilter(node);

        // For non-root: prune only if self fails filters AND no children survived
        if (node.kind !== "root") {
            if (!selfMatchesStatus && agentChildren.length === 0) return null;
            if (lowerQuery && !selfMatchesQuery && agentChildren.length === 0) return null;
        }

        const recentPreview = getRecentActivityPreview(model, node);
        return { key: nodeKey, node, record, children: agentChildren, depth, recentPreview };
    }

    function walkAgentsDeep(nodeKey: string, depth: number): HierarchyAgentNode[] {
        const node = model.nodesByKey.get(nodeKey);
        if (!node) return [];
        if (node.kind === "subagent") {
            const result = walkAgents(nodeKey, depth);
            return result ? [result] : [];
        }
        const found: HierarchyAgentNode[] = [];
        for (const childKey of node.childKeys) {
            found.push(...walkAgentsDeep(childKey, depth));
        }
        return found;
    }

    return walkAgents(model.rootNodeKey, 0);
}

function HierarchyCard({
    agentNode,
    model,
    selection,
    onSelect,
    defaultExpanded,
    query,
}: {
    agentNode: HierarchyAgentNode;
    model: ActivityModel;
    selection: Selection;
    onSelect: (selection: Selection) => void;
    defaultExpanded: boolean;
    query: string;
}) {
    const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
    const { node, record, children, depth, recentPreview } = agentNode;
    const isRoot = node.kind === "root";
    const isSelected = selectionKey(selection) === `${node.kind}:${node.id}`;
    const hasChildren = children.length > 0;
    // Force expand when searching, otherwise use manual override or default
    const expanded = query ? true : (manualExpanded ?? defaultExpanded);

    const displayName = isRoot
        ? "Main agent"
        : (record?.agentDisplayName || record?.agentName || shortId(node.id));
    const statusText = isRoot ? null : titleCase(normalizeStatus(node.status));
    const icon = isRoot ? "🧭" : statusIcon(node.status);
    const sClass = isRoot ? "" : statusClass(node.status);
    const durationMs = isRoot ? undefined : inferDurationMsForNode(model, node);
    const eventCount = node.descendantCount;
    const recentLine = recentPreview;

    const handleClick = () => {
        onSelect(selectionForNode(node));
    };

    return (
        <div className={`hierarchy-card-wrap ${isRoot ? "hierarchy-root-wrap" : ""}`}>
            <button
                type="button"
                className={`hierarchy-card ${isRoot ? "hierarchy-root-card" : ""} ${isSelected ? "selected" : ""}`}
                onClick={handleClick}
                title={displayName}
            >
                <div className="hierarchy-card-top">
                    {hasChildren && (
                        <span
                            className="hierarchy-card-toggle"
                            onClick={(e) => { e.stopPropagation(); setManualExpanded((v) => !(v ?? defaultExpanded)); }}
                            role="button"
                            tabIndex={-1}
                        >
                            {expanded ? "▾" : "▸"}
                        </span>
                    )}
                    <span className={`hierarchy-card-icon ${sClass}`}>{icon}</span>
                    <span className="hierarchy-card-name">{displayName}</span>
                    {statusText && <span className={`hierarchy-card-status ${sClass}`}>{statusText}</span>}
                    {durationMs != null && <span className="hierarchy-card-duration">{fmtDuration(durationMs)}</span>}
                </div>
                <div className="hierarchy-card-bottom">
                    <span className="hierarchy-card-counts">
                        {pluralize(eventCount, "descendant")}
                        {!isRoot && record?.totalToolCalls != null && ` · ${record.totalToolCalls} tools`}
                    </span>
                    <span className="hierarchy-card-recent">{recentLine}</span>
                </div>
            </button>

            {isRoot && children.length === 0 && (
                <div className="hierarchy-empty">No subagents spawned</div>
            )}

            {hasChildren && expanded && (
                <div className="hierarchy-children">
                    {children.map((child) => (
                        <HierarchyCard
                            key={child.key}
                            agentNode={child}
                            model={model}
                            selection={selection}
                            onSelect={onSelect}
                            defaultExpanded={child.depth < 2}
                            query={query}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function AgentHierarchyPanel({
    model,
    selection,
    onSelect,
    filters,
    query,
}: {
    model: ActivityModel;
    selection: Selection;
    onSelect: (selection: Selection) => void;
    filters: FilterState;
    query: string;
}) {
    const hierarchy = useMemo(
        () => buildAgentHierarchy(model, filters, query),
        [model, filters, query],
    );

    const hasSubagents = model.subagentMap.size > 0;
    const [panelOpen, setPanelOpen] = useState<boolean | null>(null);
    const isOpen = query ? true : (panelOpen ?? hasSubagents);

    if (!hierarchy) return null;

    return (
        <div className={`hierarchy-panel ${isOpen ? "hierarchy-panel-open" : "hierarchy-panel-closed"}`}>
            <button
                type="button"
                className="hierarchy-header"
                onClick={() => {
                    if (query) return;
                    setPanelOpen((v) => !(v ?? hasSubagents));
                }}
            >
                <span className="hierarchy-header-toggle">{isOpen ? "▾" : "▸"}</span>
                <span className="hierarchy-header-title">Agent Hierarchy</span>
                <span className="hierarchy-header-count">{model.subagentMap.size} subagent{model.subagentMap.size !== 1 ? "s" : ""}</span>
            </button>
            {isOpen && (
                <div className="hierarchy-body">
                    <HierarchyCard
                        agentNode={hierarchy}
                        model={model}
                        selection={selection}
                        onSelect={onSelect}
                        defaultExpanded={true}
                        query={query}
                    />
                </div>
            )}
        </div>
    );
}

function ActivityWorkspace({
    model,
    selection,
    onSelect,
}: {
    model: ActivityModel;
    selection: Selection;
    onSelect: (selection: Selection) => void;
}) {
    const [viewMode, setViewMode] = useState<ViewMode>("tree");
    const [search, setSearch] = useState("");
    const [filters, setFilters] = useState<FilterState>({
        subagents: true,
        tools: true,
        messages: true,
        running: true,
        complete: true,
        failed: true,
        root: true,
    });

    const query = search.trim().toLowerCase();
    const visibleTree = useMemo(
        () => buildVisibleTree(model, model.rootNodeKey, filters, query),
        [filters, model, query],
    );

    const toggleFilter = useCallback((key: FilterKey) => {
        setFilters((current) => ({ ...current, [key]: !current[key] }));
    }, []);

    const clearSearch = useCallback(() => setSearch(""), []);

    return (
        <>
            <div className="activity-toolbar">
                <div className="toolbar-row">
                    <div className="segmented">
                        <button
                            type="button"
                            className={`segmented-button ${viewMode === "tree" ? "active" : ""}`}
                            onClick={() => setViewMode("tree")}
                        >
                            Activity tree
                        </button>
                        <button
                            type="button"
                            className={`segmented-button ${viewMode === "timeline" ? "active" : ""}`}
                            onClick={() => setViewMode("timeline")}
                        >
                            Recent activity
                        </button>
                    </div>
                    <div className="search-wrap">
                        <input
                            className="search-input"
                            type="search"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder="Search subagents, tools, recent activity…"
                        />
                        {search && (
                            <button type="button" className="clear-search" onClick={clearSearch}>
                                Clear
                            </button>
                        )}
                    </div>
                </div>

                <div className="toolbar-row toolbar-row-wrap">
                    <div className="filter-group">
                        <span className="filter-label">Type</span>
                        <FilterButton active={filters.subagents} label="Subagents" onClick={() => toggleFilter("subagents")} />
                        <FilterButton active={filters.tools} label="Tools" onClick={() => toggleFilter("tools")} />
                        <FilterButton active={filters.messages} label="Messages" onClick={() => toggleFilter("messages")} />
                    </div>
                    <div className="filter-group">
                        <span className="filter-label">Status</span>
                        <FilterButton active={filters.running} label="Running" onClick={() => toggleFilter("running")} />
                        <FilterButton active={filters.complete} label="Complete" onClick={() => toggleFilter("complete")} />
                        <FilterButton active={filters.failed} label="Failed" onClick={() => toggleFilter("failed")} />
                        <FilterButton active={filters.root} label="Root / orphan" onClick={() => toggleFilter("root")} />
                    </div>
                </div>
            </div>

            {viewMode === "tree" ? (
                <>
                    <AgentHierarchyPanel
                        model={model}
                        selection={selection}
                        onSelect={onSelect}
                        filters={filters}
                        query={query}
                    />
                    <ExecutionTreeView
                        model={model}
                        visibleTree={visibleTree}
                        query={query}
                        selection={selection}
                        onSelect={onSelect}
                    />
                </>
            ) : (
                <FlatTimelineView
                    items={model.items}
                    filters={filters}
                    query={query}
                    selection={selection}
                    onSelect={onSelect}
                />
            )}
        </>
    );
}

function DetailHero({
    kicker,
    title,
    subtitle,
    pills,
}: {
    kicker: string;
    title: string;
    subtitle?: string;
    pills: DetailHeroPill[];
}) {
    return (
        <div className="detail-hero">
            <div className="detail-hero-kicker">{kicker}</div>
            <h3>{title}</h3>
            {subtitle && <div className="detail-hero-subtitle">{subtitle}</div>}
            {pills.length > 0 && (
                <div className="detail-hero-pills">
                    {pills.map((pill) => (
                        <span key={`${pill.label}-${pill.className ?? ""}`} className={pill.className ?? "summary-chip"}>
                            {pill.label}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

function DetailDisclosure({
    title,
    children,
    defaultOpen = false,
}: {
    title: string;
    children: React.ReactNode;
    defaultOpen?: boolean;
}) {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    return (
        <details
            className="detail-disclosure"
            open={isOpen}
            onToggle={(e) => setIsOpen((e.target as HTMLDetailsElement).open)}
        >
            <summary className="detail-disclosure-summary">{title}</summary>
            <div className="detail-disclosure-body">{children}</div>
        </details>
    );
}

function Breadcrumbs({ pathKeys, model }: { pathKeys: string[]; model: ActivityModel }) {
    return (
        <div className="breadcrumb-trail">
            {pathKeys.map((pathKey, index) => (
                <React.Fragment key={pathKey}>
                    <span className={`breadcrumb breadcrumb-${parseNodeKey(pathKey).kind}`}>
                        {getNodeTitleByKey(model.nodesByKey, pathKey)}
                    </span>
                    {index < pathKeys.length - 1 && <span className="breadcrumb-sep">›</span>}
                </React.Fragment>
            ))}
        </div>
    );
}

function ChildNodeList({ nodes, emptyText = "No recent activity yet." }: { nodes: ExecutionNode[]; emptyText?: string }) {
    if (nodes.length === 0) {
        return <div className="detail-text detail-fallback">{emptyText}</div>;
    }
    return (
        <div className="child-list">
            {nodes.slice(0, 20).map((node) => (
                <div key={node.key} className="child-row">
                    <span className={`child-row-icon ${statusClass(node.status)}`}>{node.icon}</span>
                    <span className="child-row-main">
                        <span className="child-row-title">{node.title}</span>
                        {node.subtitle && <span className="child-row-subtitle">{node.subtitle}</span>}
                    </span>
                    <span className="child-row-time">{fmtTime(node.ts)}</span>
                </div>
            ))}
        </div>
    );
}

function DetailPane({
    snapshot,
    model,
    selection,
}: {
    snapshot: Snapshot;
    model: ActivityModel;
    selection: Selection;
}) {
    if (!selection) {
        return <div className="detail-empty">Select root, branch, tool, or message to inspect details.</div>;
    }

    const structuralNodeKey = selectionToStructuralNodeKey(selection, model);
    const structuralNode = structuralNodeKey ? model.nodesByKey.get(structuralNodeKey) : null;
    const pathKeys = structuralNode?.pathKeys ?? [model.rootNodeKey];
    const directChildren = structuralNode ? structuralNode.childKeys.map((childKey) => model.nodesByKey.get(childKey)).filter((node): node is ExecutionNode => node != null) : [];
    const descendants = structuralNode ? collectDescendantNodes(model, structuralNode.key) : [];

    if (selection.kind === "root") {
        const rootNode = model.nodesByKey.get(model.rootNodeKey);
        const rootOwnedChildren = directChildren.filter((node) => node.kind !== "subagent");
        const recentActivity = rootNode ? getRecentActivityNodes(model, rootNode, 8) : [];

        return (
            <div className="detail-content">
                <DetailHero
                    kicker="Background Tasks"
                    title="🧭 Root session"
                    subtitle="Foreground session + orphan activity"
                    pills={[
                        { label: "Status: Active", className: "summary-chip" },
                        { label: pluralize(rootNode?.childKeys.length ?? 0, "top-level branch"), className: "summary-chip" },
                        { label: pluralize(rootNode?.descendantCount ?? 0, "descendant"), className: "summary-chip" },
                        { label: `Updated ${fmtTime(rootNode?.ts)}`, className: "summary-chip" },
                    ]}
                />
                <FieldTable fields={[
                    ["Status", "Active"],
                    ["ID", "root"],
                    ["Type", "root"],
                    ["Desc", "Foreground session + orphan activity"],
                    ["Model", UNAVAILABLE_FROM_EVENT_STREAM],
                    ["Prompt", UNAVAILABLE_FROM_EVENT_STREAM],
                ]} />

                <div className="detail-section">
                    <h4>Recent Activity</h4>
                    <ChildNodeList nodes={recentActivity} />
                </div>

                <DetailDisclosure title="Observer Context">
                    <FieldTable fields={[
                        ["Top-level branches", String(rootNode?.childKeys.length ?? 0)],
                        ["Descendants", String(rootNode?.descendantCount ?? 0)],
                        ["Root-owned nodes", String(rootOwnedChildren.length)],
                        ["Orphan nodes", String(model.graph.orphanNodeKeys.length)],
                        ["Last activity", fmtTime(rootNode?.ts)],
                    ]} />
                    <div className="detail-section">
                        <h4>Lineage</h4>
                        <Breadcrumbs pathKeys={rootNode?.pathKeys ?? [model.rootNodeKey]} model={model} />
                    </div>
                </DetailDisclosure>
            </div>
        );
    }

    if (selection.kind === "subagent") {
        const record = snapshot.subagents.find((subagent) => subagent.id === selection.id);
        if (!record || !structuralNode) return <div className="detail-empty">Subagent not found.</div>;

        const subtreeTools = descendants.filter((node) => node.kind === "toolcall");
        const subtreeMessages = descendants.filter((node) => node.kind === "message");
        const promptText = getNodePromptText(model, structuralNode);
        const recentActivity = getRecentActivityNodes(model, structuralNode, 8);

        return (
            <div className="detail-content">
                <DetailHero
                    kicker="Background Subagent"
                    title={`${statusIcon(record.status)} ${record.agentDisplayName || record.agentName}`}
                    subtitle={getNodeDescription(model, structuralNode)}
                    pills={[
                        { label: formatNodeStatusSummary(model, structuralNode), className: `lane-status ${statusClass(record.status)}` },
                        { label: `Type: ${getNodeTypeLabel(model, structuralNode)}`, className: "summary-chip" },
                        { label: `Updated ${fmtTime(structuralNode.ts)}`, className: "summary-chip" },
                    ]}
                />
                <FieldTable fields={[
                    ["Status", formatNodeStatusSummary(model, structuralNode)],
                    ["ID", shortId(record.id)],
                    ["Type", getNodeTypeLabel(model, structuralNode)],
                    ["Desc", getNodeDescription(model, structuralNode)],
                    ["Model", getNodeModelLabel(model, structuralNode)],
                    ["Prompt", previewText(safeText(promptText), 100)],
                ]} />

                <div className="detail-section">
                    <h4>Recent Activity</h4>
                    <ChildNodeList nodes={recentActivity} />
                </div>

                <div className="detail-section">
                    <h4>Prompt (first 10 lines)</h4>
                    <ExpandablePre text={promptText} limit={800} />
                </div>

                <DetailDisclosure title="Observer Context">
                    <FieldTable fields={[
                        ["Parent", getNodeTitleByKey(model.nodesByKey, structuralNode.parentKey)],
                        ["Started", fmtTime(record.startedAt)],
                        ["Completed", fmtTime(record.completedAt)],
                        ["Failed", record.failedAt ? fmtTime(record.failedAt) : undefined],
                        ["Duration", fmtDuration(record.durationMs)],
                        ["Direct children", String(structuralNode.childKeys.length)],
                        ["Descendants", String(structuralNode.descendantCount)],
                        ["Tree tools", String(subtreeTools.length)],
                        ["Tree messages", String(subtreeMessages.length)],
                        ["Tool Calls", record.totalToolCalls?.toString()],
                        ["Tokens", record.totalTokens?.toString()],
                    ]} />
                    <div className="detail-section">
                        <h4>Lineage</h4>
                        <Breadcrumbs pathKeys={pathKeys} model={model} />
                    </div>
                </DetailDisclosure>

                {record.error && (
                    <div className="detail-section detail-error">
                        <h4>Error</h4>
                        <pre className="detail-pre">{record.error}</pre>
                    </div>
                )}
            </div>
        );
    }

    if (selection.kind === "toolcall") {
        const record = snapshot.toolCalls.find((tool) => tool.id === selection.id);
        if (!record) return <div className="detail-empty">Tool call not found.</div>;
        const fallbackNode = structuralNode ?? model.nodesByKey.get(model.rootNodeKey)!;
        const promptFromArguments = extractNamedText(record.arguments, ["prompt", "description", "task", "goal", "query", "message", "content", "input", "request"]);
        const promptText = structuralNode
            ? getNodePromptText(model, structuralNode)
            : (promptFromArguments ? toPromptBlock(promptFromArguments) : UNAVAILABLE_FROM_EVENT_STREAM);
        const modelText = extractNamedText(record.arguments, ["model", "modelName", "overrideModel", "override_model"]);
        const statusSummary = formatToolRecordStatusSummary(record);
        const recentActivity = structuralNode ? getRecentActivityNodes(model, structuralNode, 8) : [];

        return (
            <div className="detail-content">
                <DetailHero
                    kicker="Background Task Detail"
                    title={`${statusIcon(record.status)} ${record.toolName || "Tool Call"}`}
                    subtitle={record.toolName || getNodeDescription(model, fallbackNode)}
                    pills={[
                        { label: statusSummary, className: `lane-status ${statusClass(record.status)}` },
                        { label: "Type: tool", className: "summary-chip" },
                        { label: `Updated ${fmtTime(record.completedAt || record.startedAt || structuralNode?.ts)}`, className: "summary-chip" },
                    ]}
                />
                <FieldTable fields={[
                    ["Status", statusSummary],
                    ["ID", shortId(record.id)],
                    ["Type", "tool"],
                    ["Desc", record.toolName || getNodeDescription(model, fallbackNode)],
                    ["Model", modelText ? previewText(safeText(modelText), 80) : UNAVAILABLE_FROM_EVENT_STREAM],
                    ["Prompt", previewText(safeText(promptText), 100)],
                ]} />

                {model.subagentMap.has(record.id) && (
                    <div className="detail-section">
                        <h4>Spawned branch</h4>
                        <p className="detail-text">This task tool call is represented as a subagent branch in the execution tree.</p>
                    </div>
                )}

                <div className="detail-section">
                    <h4>Recent Activity</h4>
                    <ChildNodeList nodes={recentActivity} />
                </div>

                <div className="detail-section">
                    <h4>Prompt (first 10 lines)</h4>
                    <ExpandablePre text={promptText} limit={800} />
                </div>

                <DetailDisclosure title="Observer Context">
                    <FieldTable fields={[
                        ["Branch", getNodeTitleByKey(model.nodesByKey, structuralNode?.parentKey)],
                        ["Parent", record.parentToolCallId === SYNTHETIC_ROOT_ID ? "root session" : shortId(record.parentToolCallId)],
                        ["Success", record.success != null ? String(record.success) : undefined],
                        ["Started", fmtTime(record.startedAt)],
                        ["Completed", fmtTime(record.completedAt)],
                        ["Direct children", structuralNode ? String(structuralNode.childKeys.length) : undefined],
                        ["Descendants", structuralNode ? String(structuralNode.descendantCount) : undefined],
                    ]} />
                    <div className="detail-section">
                        <h4>Lineage</h4>
                        <Breadcrumbs pathKeys={pathKeys} model={model} />
                    </div>
                </DetailDisclosure>

                {record.arguments != null && (
                    <DetailDisclosure title="Arguments" defaultOpen={true}>
                        <ExpandablePre
                            text={typeof record.arguments === "string" ? record.arguments : JSON.stringify(record.arguments, null, 2)}
                            limit={1500}
                        />
                    </DetailDisclosure>
                )}

                {record.resultPreview != null && (
                    <DetailDisclosure title="Result Preview" defaultOpen={true}>
                        <ExpandablePre text={record.resultPreview} limit={1000} />
                    </DetailDisclosure>
                )}
            </div>
        );
    }

    const record = snapshot.messages.find((message) => message.id === selection.id);
    if (!record) return <div className="detail-empty">Message not found.</div>;

    return (
        <div className="detail-content">
            <DetailHero
                kicker="Background Task Detail"
                title={`💬 ${previewText(safeText(record.content) || "(empty)", 88)}`}
                subtitle={getNodeDescription(model, structuralNode ?? model.nodesByKey.get(model.rootNodeKey)!)}
                pills={[
                    { label: "Complete", className: "lane-status status-complete" },
                    { label: "Type: assistant.message", className: "summary-chip" },
                    { label: `Updated ${fmtTime(record.timestamp)}`, className: "summary-chip" },
                ]}
            />
            <FieldTable fields={[
                ["Status", "Complete"],
                ["ID", shortId(record.id)],
                ["Type", "assistant.message"],
                ["Desc", getNodeDescription(model, structuralNode ?? model.nodesByKey.get(model.rootNodeKey)!)],
                ["Model", UNAVAILABLE_FROM_EVENT_STREAM],
                ["Prompt", previewText(safeText(record.content), 100) || UNAVAILABLE_FROM_EVENT_STREAM],
            ]} />

            <div className="detail-section">
                <h4>Prompt (first 10 lines)</h4>
                <ExpandablePre text={record.content ? toPromptBlock(record.content) : UNAVAILABLE_FROM_EVENT_STREAM} limit={800} />
            </div>

            <div className="detail-section">
                <h4>Recent Activity</h4>
                <ChildNodeList nodes={[]} emptyText="No child activity for messages." />
            </div>

            <DetailDisclosure title="Observer Context">
                <FieldTable fields={[
                    ["Branch", getNodeTitleByKey(model.nodesByKey, structuralNode?.parentKey)],
                    ["Parent", record.parentToolCallId === SYNTHETIC_ROOT_ID ? "root session" : shortId(record.parentToolCallId)],
                    ["Tool Requests", record.toolRequestCount.toString()],
                    ["Time", fmtTime(record.timestamp)],
                ]} />
                <div className="detail-section">
                    <h4>Lineage</h4>
                    <Breadcrumbs pathKeys={pathKeys} model={model} />
                </div>
            </DetailDisclosure>

            {record.content && (
                <DetailDisclosure title="Content" defaultOpen={true}>
                    <ExpandablePre text={record.content} limit={1000} />
                </DetailDisclosure>
            )}

            {record.reasoningAvailability !== "unsupported" && (
                <DetailDisclosure title="Reasoning" defaultOpen={true}>
                    <ReasoningSection availability={record.reasoningAvailability} text={record.reasoningText} />
                </DetailDisclosure>
            )}
        </div>
    );
}

function ReasoningSection({ availability, text }: { availability: string; text?: string }) {
    return (
        <div className="detail-section detail-section-inline">
            {availability === "available" && (text ? (
                <pre className="detail-pre reasoning-text">{text}</pre>
            ) : (
                <div className="reasoning-empty">
                    <span className="reasoning-empty-icon">💭</span>
                    Reasoning was marked available but contained no text.
                </div>
            ))}
            {availability === "empty" && (
                <div className="reasoning-empty">
                    <span className="reasoning-empty-icon">💭</span>
                    Reasoning field was present but empty for this message.
                </div>
            )}
            {availability === "unsupported" && (
                <div className="reasoning-empty">
                    <span className="reasoning-empty-icon">🚫</span>
                    Reasoning is not available — the model or event type does not expose thinking text.
                </div>
            )}
        </div>
    );
}

function FieldTable({ fields }: { fields: [string, string | undefined][] }) {
    const visible = fields.filter(([, value]) => value != null && value !== "—" && value !== "");
    if (visible.length === 0) return null;

    return (
        <table className="field-table">
            <tbody>
                {visible.map(([label, value]) => (
                    <tr key={label}>
                        <td className="field-label">{label}</td>
                        <td className="field-value">{value}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function App() {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selection, setSelection] = useState<Selection>(null);
    const lastRawRef = useRef<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const raw = await copilot.getSnapshot();
            if (raw === lastRawRef.current) {
                setError(null);
                return;
            }
            lastRawRef.current = raw;
            const parsed = JSON.parse(raw);

            if (parsed && typeof parsed.stats === "object" && Array.isArray(parsed.timeline)) {
                setSnapshot(parsed);
                setError(null);
            } else {
                setError("Unexpected snapshot shape");
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, []);

    useEffect(() => {
        void refresh();

        let inflight = false;
        const tick = async () => {
            if (document.visibilityState === "hidden") return;
            if (inflight) return;
            inflight = true;
            try { await refresh(); } finally { inflight = false; }
        };
        const onVisible = () => {
            if (document.visibilityState === "visible") {
                void tick();
            }
        };
        const id = setInterval(() => { void tick(); }, 3000);
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onVisible);

        return () => {
            clearInterval(id);
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("focus", onVisible);
        };
    }, [refresh]);

    const model = useMemo(() => (snapshot ? buildActivityModel(snapshot) : null), [snapshot]);

    useEffect(() => {
        if (selection && !selectionExists(selection, model)) {
            setSelection(null);
        }
    }, [model, selection]);

    const hasData = snapshot && snapshot.stats.ingestedEventCount > 0;

    return (
        <>
            <header>
                <h1>🔭 Agent Observer</h1>
                {snapshot && (
                    <>
                        <span className="badge">{snapshot.stats.subagentCount} subagent{snapshot.stats.subagentCount !== 1 ? "s" : ""}</span>
                        <span className="badge">{snapshot.stats.toolCallCount} tool call{snapshot.stats.toolCallCount !== 1 ? "s" : ""}</span>
                        <span className="badge">{snapshot.stats.messageCount} msg{snapshot.stats.messageCount !== 1 ? "s" : ""}</span>
                    </>
                )}
            </header>

            {error && <div className="error-bar">⚠️ {error}</div>}

            {!error && !snapshot && (
                <main><div className="placeholder">Loading…</div></main>
            )}

            {!error && snapshot && !hasData && (
                <main>
                    <div className="placeholder">
                        No events captured yet.<br />
                        Trigger a subagent run to see activity here.
                    </div>
                </main>
            )}

            {!error && snapshot && hasData && model && (
                <>
                    <OverviewCards stats={snapshot.stats} subagents={snapshot.subagents} />
                    <div className="panels">
                        <section className="panel-list">
                            <div className="panel-header">Background Tasks</div>
                            <ActivityWorkspace model={model} selection={selection} onSelect={setSelection} />
                        </section>
                        <section className="panel-detail">
                            <div className="panel-header">Subagent Details</div>
                            <DetailPane snapshot={snapshot} model={model} selection={selection} />
                        </section>
                    </div>
                </>
            )}
        </>
    );
}

window.addEventListener("error", (event) => {
    renderFatal(event.message || "Unhandled window error", event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
    renderFatal("Unhandled promise rejection", event.reason);
});

try {
    const rootEl = document.getElementById("root");
    if (!rootEl) {
        throw new Error("Missing #root element");
    }

    createRoot(rootEl).render(
        <FatalBoundary>
            <App />
        </FatalBoundary>,
    );
} catch (error) {
    renderFatal("Top-level boot failure", error);
}
