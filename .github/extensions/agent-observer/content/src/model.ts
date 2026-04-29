/**
 * Model-building logic — transforms raw snapshots into the ActivityModel
 * used by all UI components. Also contains tree-filtering and query functions.
 */

import type {
    Snapshot,
    ExecutionGraphSnapshot,
    ExecutionNode,
    ActivityItem,
    ActivityModel,
    VisibleTreeNode,
    FilterState,
    Selection,
    NodeKind,
    HierarchyAgentNode,
    SubagentRecord,
} from "./types.js";
import { SYNTHETIC_ROOT_ID, UNAVAILABLE_FROM_EVENT_STREAM } from "./types.js";
import {
    shortId,
    fmtTime,
    fmtDuration,
    statusIcon,
    normalizeStatus,
    safeText,
    previewText,
    summarizeArgs,
    resultSnippet,
    compareIsoDesc,
    stringifyForSearch,
    titleCase,
    extractNamedText,
    toPromptBlock,
    makeNodeKey,
    parseNodeKey,
} from "./helpers.js";

/* ── Timestamp helpers ──────────────────────────────────────────────────── */

function nodeOriginTimestamp(kind: NodeKind, id: string, snapshot: Snapshot): string {
    if (kind === "root") return latestSnapshotTimestamp(snapshot);
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

/* ── Fallback execution graph ───────────────────────────────────────────── */

export function buildFallbackExecutionGraph(snapshot: Snapshot): ExecutionGraphSnapshot {
    const rootNodeKey = makeNodeKey("root", SYNTHETIC_ROOT_ID);
    const childNodeKeys: Record<string, string[]> = { [rootNodeKey]: [] };
    const nodeParentKeys: Record<string, string | null> = { [rootNodeKey]: null };
    const hiddenToolCallIds = new Set(snapshot.subagents.map((record) => record.id));
    const subagentIds = new Set(snapshot.subagents.map((record) => record.id));
    const toolCallIds = new Set(snapshot.toolCalls.map((record) => record.id));
    const orphanKeys = new Set<string>();

    function ensureBucket(key: string): string[] {
        if (!childNodeKeys[key]) childNodeKeys[key] = [];
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

/* ── Node query helpers ─────────────────────────────────────────────────── */

export function getNodeTitleByKey(nodesByKey: Map<string, ExecutionNode>, key: string | null | undefined): string {
    if (!key) return nodesByKey.get("root:__root__")?.title || "Root session";
    return nodesByKey.get(key)?.title || shortId(parseNodeKey(key).id);
}

export function inferDurationMsForNode(model: ActivityModel, node: ExecutionNode): number | undefined {
    if (node.kind === "subagent") {
        const record = model.subagentMap.get(node.id);
        if (!record) return undefined;
        if (record.durationMs != null) return record.durationMs;
        const start = record.startedAt ? Date.parse(record.startedAt) : NaN;
        const endSource = record.completedAt || record.failedAt;
        const end = endSource ? Date.parse(endSource) : (record.status === "started" ? Date.now() : NaN);
        if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) return end - start;
        return undefined;
    }
    if (node.kind === "toolcall") {
        const record = model.toolCallMap.get(node.id);
        if (!record) return undefined;
        const start = record.startedAt ? Date.parse(record.startedAt) : NaN;
        const endSource = record.completedAt;
        const end = endSource ? Date.parse(endSource) : (record.status === "running" ? Date.now() : NaN);
        if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) return end - start;
    }
    return undefined;
}

export function formatNodeStatusSummary(model: ActivityModel, node: ExecutionNode): string {
    if (node.kind === "root") return "Active";
    const raw = normalizeStatus(node.status);
    const label = titleCase(raw);
    const durationMs = inferDurationMsForNode(model, node);
    return durationMs != null ? `${label} (${fmtDuration(durationMs)})` : label;
}

export function formatToolRecordStatusSummary(record: { status: string; startedAt?: string; completedAt?: string }): string {
    const label = titleCase(normalizeStatus(record.status));
    const start = record.startedAt ? Date.parse(record.startedAt) : NaN;
    const end = record.completedAt ? Date.parse(record.completedAt) : (record.status === "running" ? Date.now() : NaN);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
        return `${label} (${fmtDuration(end - start)})`;
    }
    return label;
}

export function getNodeTypeLabel(model: ActivityModel, node: ExecutionNode): string {
    if (node.kind === "root") return "root";
    if (node.kind === "subagent") return model.subagentMap.get(node.id)?.agentName || "subagent";
    if (node.kind === "toolcall") return "tool";
    return "assistant.message";
}

export function getNodeDescription(model: ActivityModel, node: ExecutionNode): string {
    if (node.kind === "root") return node.subtitle || "Foreground session + orphan activity";
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

export function getNodeModelLabel(model: ActivityModel, node: ExecutionNode): string {
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

export function getNodePromptText(model: ActivityModel, node: ExecutionNode): string {
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

export function getRecentActivityNodes(model: ActivityModel, node: ExecutionNode, limit = 8): ExecutionNode[] {
    if (node.kind === "message") return [];
    return collectDescendantNodes(model, node.key)
        .slice()
        .sort((a, b) => compareIsoDesc(a.ts, b.ts))
        .slice(0, limit);
}

export function getRecentActivityPreview(model: ActivityModel, node: ExecutionNode): string {
    const recent = getRecentActivityNodes(model, node, 1)[0];
    if (!recent) return "No recent activity yet";
    return recent.subtitle ? `${recent.title} — ${recent.subtitle}` : recent.title;
}

/* ── Model builder ──────────────────────────────────────────────────────── */

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
    const rootNode = nodesByKey.get("root:__root__");
    return { ownerId: SYNTHETIC_ROOT_ID, ownerLabel: rootNode?.title || "Root session" };
}

export function buildActivityModel(snapshot: Snapshot): ActivityModel {
    const subagentMap = new Map(snapshot.subagents.map((record) => [record.id, record]));
    const toolCallMap = new Map(snapshot.toolCalls.map((record) => [record.id, record]));
    const messageMap = new Map(snapshot.messages.map((record) => [record.id, record]));

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

    const meta = snapshot.sessionMeta;
    const rootTitle = meta?.label || "Root session";
    const rootSubtitle = meta
        ? `pid ${meta.pid} · foreground session + orphan activity`
        : "Foreground session + orphan activity";

    nodesByKey.set(rootNodeKey, {
        key: rootNodeKey,
        kind: "root",
        id: SYNTHETIC_ROOT_ID,
        ts: latestSnapshotTimestamp(snapshot),
        status: "complete",
        icon: "🧭",
        kindLabel: "root",
        title: rootTitle,
        subtitle: rootSubtitle,
        searchText: `root session orphan foreground ${meta?.cwdName ?? ""} ${meta?.branch ?? ""}`.toLowerCase(),
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

/* ── Selection + filtering ──────────────────────────────────────────────── */

export function selectionToStructuralNodeKey(selection: Selection, model: ActivityModel): string | null {
    if (!selection) return null;
    if (selection.kind === "root") return model.rootNodeKey;
    const directKey = makeNodeKey(selection.kind, selection.id);
    if (model.nodesByKey.has(directKey)) return directKey;
    const mirroredSubagentKey = makeNodeKey("subagent", selection.id);
    if (model.nodesByKey.has(mirroredSubagentKey)) return mirroredSubagentKey;
    return null;
}

export function matchesItemFilters(item: ActivityItem, filters: FilterState, query: string): boolean {
    if (item.kind === "subagent" && !filters.subagents) return false;
    if (item.kind === "toolcall" && !filters.tools) return false;
    if (item.kind === "message" && !filters.messages) return false;
    if (item.kind !== "message" && !filters[normalizeStatus(item.status)]) return false;
    if (!filters.root && (item.orphan || (item.kind !== "subagent" && item.ownerId === SYNTHETIC_ROOT_ID))) return false;
    if (!query) return true;
    return item.searchText.includes(query) || item.ownerLabel.toLowerCase().includes(query);
}

export function matchesNodeFilters(node: ExecutionNode, filters: FilterState, query: string): boolean {
    if (node.kind === "subagent" && !filters.subagents) return false;
    if (node.kind === "toolcall" && !filters.tools) return false;
    if (node.kind === "message" && !filters.messages) return false;
    if (node.kind !== "root" && node.kind !== "message" && !filters[normalizeStatus(node.status)]) return false;
    if (!query) return true;
    return node.searchText.includes(query) || node.title.toLowerCase().includes(query);
}

export function buildVisibleTree(
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

    if (blockedByRootContext) return null;

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

export function collectDescendantNodes(model: ActivityModel, nodeKey: string): ExecutionNode[] {
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

export function selectionForNode(node: ExecutionNode): Selection {
    if (node.kind === "root") return { kind: "root", id: SYNTHETIC_ROOT_ID };
    return { kind: node.kind, id: node.id };
}

export function selectionExists(selection: Selection, model: ActivityModel | null): boolean {
    if (!selection || !model) return true;
    return selectionToStructuralNodeKey(selection, model) != null;
}

/* ── Agent Hierarchy builder ────────────────────────────────────────────── */

export function buildAgentHierarchy(
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
        return node.searchText.includes(lowerQuery) || name.toLowerCase().includes(lowerQuery);
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

        const agentChildren: HierarchyAgentNode[] = [];
        for (const childKey of node.childKeys) {
            const childNode = model.nodesByKey.get(childKey);
            if (!childNode) continue;
            if (childNode.kind === "subagent") {
                const childResult = walkAgents(childKey, depth + 1);
                if (childResult) agentChildren.push(childResult);
            } else {
                for (const grandchildKey of childNode.childKeys) {
                    const found = walkAgentsDeep(grandchildKey, depth + 1);
                    agentChildren.push(...found);
                }
            }
        }

        const selfMatchesQuery = matchesQuery(node, record);
        const selfMatchesStatus = matchesStatusFilter(node);

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
