/**
 * Subagent Observer — hierarchy-first execution tree UI
 *
 * Read-only dashboard showing:
 *   - Overview cards (stats + subagent status)
 *   - Default execution tree / tree-table with real parent-child structure
 *   - Secondary flat timeline for raw chronology/debugging
 *   - Detail pane with lineage breadcrumbs for the selected node
 *
 * Data comes from the normalized event store via copilot.getSnapshot().
 * Auto-refreshes every 2 seconds.
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
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

const SYNTHETIC_ROOT_ID = "__root__";

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
          <div class="fatal-title">Subagent Observer failed to render</div>
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
                record.resultPreview ? previewText(safeText(record.resultPreview), 80) : "",
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
        nodesByKey.set(key, {
            key,
            kind: "message",
            id: record.id,
            ts: record.timestamp || record._lastEventTs,
            status: "complete",
            icon: "💬",
            kindLabel: "msg",
            title: previewText(content || "(empty)", 88),
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
                subtitle: record.resultPreview ? previewText(safeText(record.resultPreview), 72) : "",
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
        console.error("Subagent Observer render failed", error);
    }

    render() {
        if (this.state.error) {
            return (
                <div className="fatal-screen">
                    <div className="fatal-box">
                        <div className="fatal-title">Subagent Observer failed to render</div>
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
                <div className="card-label">Subagents</div>
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
    selection,
    collapsed,
    onToggle,
    onSelect,
    query,
}: {
    branch: VisibleTreeNode;
    model: ActivityModel;
    selection: Selection;
    collapsed: Record<string, boolean>;
    onToggle: (key: string) => void;
    onSelect: (selection: Selection) => void;
    query: string;
}) {
    const node = model.nodesByKey.get(branch.key);
    if (!node) return null;

    const selectedNodeKey = selectionToStructuralNodeKey(selection, model);
    const selectedPath = selectedNodeKey ? new Set(model.nodesByKey.get(selectedNodeKey)?.pathKeys ?? []) : new Set<string>();
    const isSelected = selectedNodeKey === node.key;
    const inSelectedPath = !isSelected && selectedPath.has(node.key);
    const hasChildren = branch.children.length > 0;
    const isExpanded = query
        ? true
        : selectedPath.has(node.key)
            ? true
            : !(collapsed[node.key] ?? false);

    return (
        <div className={`tree-branch ${node.kind === "root" ? "tree-branch-root" : ""}`}>
            <div className={`tree-row ${isSelected ? "selected" : ""} ${inSelectedPath ? "selected-ancestor" : ""}`}>
                <div className="tree-row-main" style={{ paddingLeft: `${10 + ((node.pathKeys.length - 1) * 16)}px` }}>
                    {hasChildren ? (
                        <button
                            type="button"
                            className="tree-toggle"
                            onClick={() => onToggle(node.key)}
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
                        onClick={() => onSelect(node.kind === "root" ? { kind: "root", id: SYNTHETIC_ROOT_ID } : { kind: node.kind, id: node.id })}
                        title={node.title}
                    >
                        <span className={`activity-icon ${statusClass(node.status)}`}>{node.icon}</span>
                        <span className="tree-title-wrap">
                            <span className="tree-title">{node.title}</span>
                            {node.subtitle && <span className="tree-subtitle">{node.subtitle}</span>}
                        </span>
                    </button>
                </div>

                <div className="tree-row-meta">
                    <span className={`kind-pill kind-pill-${node.kind}`}>{node.kindLabel}</span>
                    {node.kind !== "root" && node.kind !== "message" && (
                        <span className={`lane-status ${statusClass(node.status)}`}>{normalizeStatus(node.status)}</span>
                    )}
                    {node.childKeys.length > 0 && <span className="summary-chip">{node.childKeys.length} child</span>}
                    {node.descendantCount > node.childKeys.length && (
                        <span className="summary-chip">{node.descendantCount} total</span>
                    )}
                    {node.orphan && <span className="summary-chip summary-chip-warn">orphan</span>}
                </div>

                <div className="tree-row-time">{fmtTime(node.ts)}</div>
            </div>

            {hasChildren && isExpanded && (
                <div className="tree-children">
                    {branch.children.map((child) => (
                        <TreeBranch
                            key={child.key}
                            branch={child}
                            model={model}
                            selection={selection}
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
    filters,
    query,
    selection,
    onSelect,
}: {
    model: ActivityModel;
    filters: FilterState;
    query: string;
    selection: Selection;
    onSelect: (selection: Selection) => void;
}) {
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

    const visibleTree = useMemo(
        () => buildVisibleTree(model, model.rootNodeKey, filters, query),
        [filters, model, query],
    );

    const toggleNode = useCallback((key: string) => {
        setCollapsed((current) => ({ ...current, [key]: !current[key] }));
    }, []);

    if (!visibleTree) {
        return <div className="activity-empty">No tree nodes match the current filters.</div>;
    }

    return (
        <div className="tree-list">
            <div className="tree-head">
                <div className="tree-head-cell">Execution tree</div>
                <div className="tree-head-cell tree-head-meta">Meta</div>
                <div className="tree-head-cell tree-head-time">Updated</div>
            </div>

            <TreeBranch
                branch={visibleTree}
                model={model}
                selection={selection}
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
                            Execution tree
                        </button>
                        <button
                            type="button"
                            className={`segmented-button ${viewMode === "timeline" ? "active" : ""}`}
                            onClick={() => setViewMode("timeline")}
                        >
                            Flat timeline
                        </button>
                    </div>
                    <div className="search-wrap">
                        <input
                            className="search-input"
                            type="search"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder="Search branches, tools, messages…"
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
                        <FilterButton active={filters.subagents} label="Agents" onClick={() => toggleFilter("subagents")} />
                        <FilterButton active={filters.tools} label="Tools" onClick={() => toggleFilter("tools")} />
                        <FilterButton active={filters.messages} label="Msgs" onClick={() => toggleFilter("messages")} />
                    </div>
                    <div className="filter-group">
                        <span className="filter-label">Status</span>
                        <FilterButton active={filters.running} label="Running" onClick={() => toggleFilter("running")} />
                        <FilterButton active={filters.complete} label="Complete" onClick={() => toggleFilter("complete")} />
                        <FilterButton active={filters.failed} label="Failed" onClick={() => toggleFilter("failed")} />
                        <FilterButton active={filters.root} label="Root/orphan" onClick={() => toggleFilter("root")} />
                    </div>
                </div>
            </div>

            {viewMode === "tree" ? (
                <ExecutionTreeView
                    model={model}
                    filters={filters}
                    query={query}
                    selection={selection}
                    onSelect={onSelect}
                />
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

function ChildNodeList({ nodes }: { nodes: ExecutionNode[] }) {
    if (nodes.length === 0) return null;
    return (
        <div className="child-list">
            {nodes.slice(0, 20).map((node) => (
                <div key={node.key} className="child-row">
                    <span className={statusClass(node.status)}>{node.icon}</span>
                    <span>{node.title}</span>
                    <span className={`kind-pill kind-pill-${node.kind}`}>{node.kindLabel}</span>
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

        return (
            <div className="detail-content">
                <h3>🧭 Root session</h3>
                <div className="detail-section">
                    <h4>Lineage</h4>
                    <Breadcrumbs pathKeys={rootNode?.pathKeys ?? [model.rootNodeKey]} model={model} />
                </div>
                <FieldTable fields={[
                    ["Top-level branches", String(rootNode?.childKeys.length ?? 0)],
                    ["Descendants", String(rootNode?.descendantCount ?? 0)],
                    ["Root-owned nodes", String(rootOwnedChildren.length)],
                    ["Orphan nodes", String(model.graph.orphanNodeKeys.length)],
                    ["Last activity", fmtTime(rootNode?.ts)],
                ]} />

                {directChildren.length > 0 && (
                    <div className="detail-section">
                        <h4>Top-level branches</h4>
                        <ChildNodeList nodes={directChildren} />
                    </div>
                )}
            </div>
        );
    }

    if (selection.kind === "subagent") {
        const record = snapshot.subagents.find((subagent) => subagent.id === selection.id);
        if (!record || !structuralNode) return <div className="detail-empty">Subagent not found.</div>;

        const subtreeTools = descendants.filter((node) => node.kind === "toolcall");
        const subtreeMessages = descendants.filter((node) => node.kind === "message");

        return (
            <div className="detail-content">
                <h3>{statusIcon(record.status)} {record.agentDisplayName || record.agentName}</h3>
                <div className="detail-section">
                    <h4>Lineage</h4>
                    <Breadcrumbs pathKeys={pathKeys} model={model} />
                </div>
                <FieldTable fields={[
                    ["ID", shortId(record.id)],
                    ["Agent Name", record.agentName],
                    ["Status", record.status],
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

                {record.agentDescription && (
                    <div className="detail-section">
                        <h4>Description</h4>
                        <p className="detail-text">{record.agentDescription}</p>
                    </div>
                )}

                {directChildren.length > 0 && (
                    <div className="detail-section">
                        <h4>Direct children</h4>
                        <ChildNodeList nodes={directChildren} />
                    </div>
                )}

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

        return (
            <div className="detail-content">
                <h3>{statusIcon(record.status)} {record.toolName || "Tool Call"}</h3>
                <div className="detail-section">
                    <h4>Lineage</h4>
                    <Breadcrumbs pathKeys={pathKeys} model={model} />
                </div>
                <FieldTable fields={[
                    ["ID", shortId(record.id)],
                    ["Tool", record.toolName],
                    ["Branch", getNodeTitleByKey(model.nodesByKey, structuralNode?.parentKey)],
                    ["Parent", record.parentToolCallId === SYNTHETIC_ROOT_ID ? "root session" : shortId(record.parentToolCallId)],
                    ["Status", record.status],
                    ["Success", record.success != null ? String(record.success) : undefined],
                    ["Started", fmtTime(record.startedAt)],
                    ["Completed", fmtTime(record.completedAt)],
                    ["Direct children", structuralNode ? String(structuralNode.childKeys.length) : undefined],
                    ["Descendants", structuralNode ? String(structuralNode.descendantCount) : undefined],
                ]} />

                {model.subagentMap.has(record.id) && (
                    <div className="detail-section">
                        <h4>Spawned branch</h4>
                        <p className="detail-text">This task tool call is represented as a subagent branch in the execution tree.</p>
                    </div>
                )}

                {record.arguments != null && (
                    <div className="detail-section">
                        <h4>Arguments</h4>
                        <pre className="detail-pre">{typeof record.arguments === "string" ? record.arguments : JSON.stringify(record.arguments, null, 2)}</pre>
                    </div>
                )}

                {record.resultPreview != null && (
                    <div className="detail-section">
                        <h4>Result Preview</h4>
                        <pre className="detail-pre">{record.resultPreview}</pre>
                    </div>
                )}

                {directChildren.length > 0 && (
                    <div className="detail-section">
                        <h4>Direct children</h4>
                        <ChildNodeList nodes={directChildren} />
                    </div>
                )}
            </div>
        );
    }

    const record = snapshot.messages.find((message) => message.id === selection.id);
    if (!record) return <div className="detail-empty">Message not found.</div>;

    return (
        <div className="detail-content">
            <h3>💬 Assistant Message</h3>
            <div className="detail-section">
                <h4>Lineage</h4>
                <Breadcrumbs pathKeys={pathKeys} model={model} />
            </div>
            <FieldTable fields={[
                ["ID", shortId(record.id)],
                ["Branch", getNodeTitleByKey(model.nodesByKey, structuralNode?.parentKey)],
                ["Parent", record.parentToolCallId === SYNTHETIC_ROOT_ID ? "root session" : shortId(record.parentToolCallId)],
                ["Tool Requests", record.toolRequestCount.toString()],
                ["Time", fmtTime(record.timestamp)],
            ]} />

            {record.content && (
                <div className="detail-section">
                    <h4>Content</h4>
                    <pre className="detail-pre">{record.content.slice(0, 2000)}{record.content.length > 2000 ? "\n…(truncated)" : ""}</pre>
                </div>
            )}

            <ReasoningSection availability={record.reasoningAvailability} text={record.reasoningText} />
        </div>
    );
}

function ReasoningSection({ availability, text }: { availability: string; text?: string }) {
    return (
        <div className="detail-section">
            <h4>Reasoning</h4>
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

    const refresh = useCallback(async () => {
        try {
            const raw = await copilot.getSnapshot();
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
        refresh();

        let inflight = false;
        const id = setInterval(async () => {
            if (inflight) return;
            inflight = true;
            try { await refresh(); } finally { inflight = false; }
        }, 2000);

        return () => clearInterval(id);
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
                <h1>🔭 Subagent Observer</h1>
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
                            <div className="panel-header">Activity</div>
                            <ActivityWorkspace model={model} selection={selection} onSelect={setSelection} />
                        </section>
                        <section className="panel-detail">
                            <div className="panel-header">Details</div>
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
