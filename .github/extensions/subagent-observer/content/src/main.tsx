/**
 * Subagent Observer — ownership-first visualization UI
 *
 * Read-only dashboard showing:
 *   - Overview cards (stats + subagent status)
 *   - Grouped subagent lanes for ownership-first scanning
 *   - Secondary flat timeline for raw chronology/debugging
 *   - Detail pane for selected items
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

interface Snapshot {
    subagents: SubagentRecord[];
    toolCalls: ToolCallRecord[];
    messages: AssistantMessageRecord[];
    toolCallsByParent: Record<string, { toolCallId: string; toolName: string; status: string }[]>;
    recentEvents: { ts: string; type: string; summary: string }[];
    timeline: TimelineRef[];
    stats: Stats;
}

interface FatalBoundaryState {
    error: string | null;
}

type Selection =
    | { kind: "subagent"; id: string }
    | { kind: "toolcall"; id: string }
    | { kind: "message"; id: string }
    | null;

type ViewMode = "grouped" | "timeline";
type StatusKey = "running" | "complete" | "failed";
type FilterKey =
    | "subagents"
    | "tools"
    | "messages"
    | "running"
    | "complete"
    | "failed"
    | "root";

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
    kind: "subagent" | "toolcall" | "message";
    id: string;
    ts: string;
    ownerId: string;
    ownerLabel: string;
    orphan: boolean;
    depth: number;
    status: string;
    icon: string;
    kindLabel: string;
    title: string;
    subtitle: string;
    searchText: string;
}

interface ActivityLane {
    id: string;
    kind: "subagent" | "root";
    title: string;
    subtitle: string;
    status: string;
    toolCount: number;
    messageCount: number;
    orphanCount: number;
    lastTs: string;
    items: ActivityItem[];
    searchText: string;
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

function selectionKey(selection: Selection): string | null {
    return selection ? `${selection.kind}:${selection.id}` : null;
}

function rowSelectionKey(item: ActivityItem): string {
    return `${item.kind}:${item.id}`;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
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
    const running = subagents.filter((s) => s.status === "started").length;
    const completed = subagents.filter((s) => s.status === "completed").length;
    const failed = subagents.filter((s) => s.status === "failed").length;

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

function resolveOwnership(
    parentToolCallId: string | undefined,
    subagentMap: Map<string, SubagentRecord>,
    toolCallMap: Map<string, ToolCallRecord>,
): { ownerId: string; depth: number; orphan: boolean } {
    if (!parentToolCallId || parentToolCallId === SYNTHETIC_ROOT_ID) {
        return { ownerId: SYNTHETIC_ROOT_ID, depth: 0, orphan: false };
    }

    let current = parentToolCallId;
    let depth = 0;
    let orphan = false;
    const seen = new Set<string>();

    while (current && current !== SYNTHETIC_ROOT_ID) {
        if (seen.has(current)) {
            orphan = true;
            break;
        }
        seen.add(current);

        if (subagentMap.has(current)) {
            return { ownerId: current, depth, orphan };
        }

        const parentTool = toolCallMap.get(current);
        if (!parentTool) {
            orphan = true;
            break;
        }

        depth++;
        current = parentTool.parentToolCallId;
    }

    return { ownerId: SYNTHETIC_ROOT_ID, depth, orphan };
}

function buildActivityModel(snapshot: Snapshot) {
    const subagentMap = new Map<string, SubagentRecord>();
    const toolCallMap = new Map<string, ToolCallRecord>();
    const messageMap = new Map<string, AssistantMessageRecord>();

    for (const record of snapshot.subagents) subagentMap.set(record.id, record);
    for (const record of snapshot.toolCalls) toolCallMap.set(record.id, record);
    for (const record of snapshot.messages) messageMap.set(record.id, record);

    const items: ActivityItem[] = [];

    for (const ref of [...snapshot.timeline].reverse()) {
        if (ref.kind === "subagent") {
            const record = subagentMap.get(ref.id);
            if (!record) continue;
            const title = record.agentDisplayName || record.agentName || shortId(record.id);
            const subtitle = `${record.totalToolCalls ?? 0} tool call${record.totalToolCalls === 1 ? "" : "s"} · ${fmtDuration(record.durationMs)}`;

            items.push({
                kind: "subagent",
                id: record.id,
                ts: record.startedAt || record._lastEventTs,
                ownerId: record.id,
                ownerLabel: title,
                orphan: false,
                depth: 0,
                status: record.status,
                icon: statusIcon(record.status),
                kindLabel: "agent",
                title,
                subtitle,
                searchText: `${title} ${record.agentName} ${record.agentDescription ?? ""}`.toLowerCase(),
            });
            continue;
        }

        if (ref.kind === "toolcall") {
            const record = toolCallMap.get(ref.id);
            if (!record) continue;
            const ownership = resolveOwnership(record.parentToolCallId, subagentMap, toolCallMap);
            const ownerLabel = ownership.ownerId === SYNTHETIC_ROOT_ID
                ? (ownership.orphan ? "Orphan chain" : "Root session")
                : (subagentMap.get(ownership.ownerId)?.agentDisplayName || subagentMap.get(ownership.ownerId)?.agentName || shortId(ownership.ownerId));
            const title = record.toolName || shortId(record.id);
            const subtitleParts = [
                ownership.orphan ? "broken parent chain" : "",
                record.resultPreview ? previewText(safeText(record.resultPreview), 60) : "",
            ].filter(Boolean);

            items.push({
                kind: "toolcall",
                id: record.id,
                ts: record.startedAt || record.completedAt || record._lastEventTs,
                ownerId: ownership.ownerId,
                ownerLabel,
                orphan: ownership.orphan,
                depth: ownership.ownerId === SYNTHETIC_ROOT_ID ? ownership.depth : ownership.depth + 1,
                status: record.status,
                icon: statusIcon(record.status),
                kindLabel: "tool",
                title,
                subtitle: subtitleParts.join(" · "),
                searchText: `${title} ${ownerLabel} ${record.resultPreview ?? ""}`.toLowerCase(),
            });
            continue;
        }

        const record = messageMap.get(ref.id);
        if (!record) continue;
        const ownership = resolveOwnership(record.parentToolCallId, subagentMap, toolCallMap);
        const ownerLabel = ownership.ownerId === SYNTHETIC_ROOT_ID
            ? (ownership.orphan ? "Orphan chain" : "Root session")
            : (subagentMap.get(ownership.ownerId)?.agentDisplayName || subagentMap.get(ownership.ownerId)?.agentName || shortId(ownership.ownerId));
        const content = safeText(record.content);
        const title = previewText(content || "(empty)", 72);
        const subtitleParts = [];
        if (record.toolRequestCount > 0) {
            subtitleParts.push(`${record.toolRequestCount} tool req${record.toolRequestCount === 1 ? "" : "s"}`);
        }
        if (ownership.orphan) {
            subtitleParts.push("broken parent chain");
        }

        items.push({
            kind: "message",
            id: record.id,
            ts: record.timestamp || record._lastEventTs,
            ownerId: ownership.ownerId,
            ownerLabel,
            orphan: ownership.orphan,
            depth: ownership.ownerId === SYNTHETIC_ROOT_ID ? ownership.depth : ownership.depth + 1,
            status: "complete",
            icon: "💬",
            kindLabel: "msg",
            title,
            subtitle: subtitleParts.join(" · "),
            searchText: `${content} ${ownerLabel}`.toLowerCase(),
        });
    }

    const laneMap = new Map<string, ActivityLane>();
    laneMap.set(SYNTHETIC_ROOT_ID, {
        id: SYNTHETIC_ROOT_ID,
        kind: "root",
        title: "Root session",
        subtitle: "Root-owned + orphan activity",
        status: "complete",
        toolCount: 0,
        messageCount: 0,
        orphanCount: 0,
        lastTs: "",
        items: [],
        searchText: "root session orphan",
    });

    for (const subagent of snapshot.subagents) {
        const title = subagent.agentDisplayName || subagent.agentName || shortId(subagent.id);
        laneMap.set(subagent.id, {
            id: subagent.id,
            kind: "subagent",
            title,
            subtitle: `${subagent.agentName || "subagent"} · ${fmtDuration(subagent.durationMs)}`,
            status: subagent.status,
            toolCount: 0,
            messageCount: 0,
            orphanCount: 0,
            lastTs: subagent._lastEventTs || subagent.startedAt || "",
            items: [],
            searchText: `${title} ${subagent.agentName} ${subagent.agentDescription ?? ""}`.toLowerCase(),
        });
    }

    for (const item of items) {
        if (item.kind === "subagent") continue;
        const lane = laneMap.get(item.ownerId) ?? laneMap.get(SYNTHETIC_ROOT_ID);
        if (!lane) continue;

        lane.items.push(item);
        if (item.kind === "toolcall") lane.toolCount++;
        if (item.kind === "message") lane.messageCount++;
        if (item.orphan) lane.orphanCount++;
        if (!lane.lastTs || compareIsoDesc(item.ts, lane.lastTs) < 0) {
            lane.lastTs = item.ts;
        }
    }

    const rootLane = laneMap.get(SYNTHETIC_ROOT_ID)!;
    const subagentLanes = [...laneMap.values()]
        .filter((lane) => lane.id !== SYNTHETIC_ROOT_ID)
        .sort((a, b) => compareIsoDesc(a.lastTs, b.lastTs));

    const lanes = rootLane.items.length > 0 || rootLane.orphanCount > 0
        ? [rootLane, ...subagentLanes]
        : subagentLanes;

    return {
        items,
        lanes,
        subagentMap,
        toolCallMap,
        messageMap,
    };
}

function matchesItemFilters(item: ActivityItem, filters: FilterState, query: string): boolean {
    if (item.kind === "subagent" && !filters.subagents) return false;
    if (item.kind === "toolcall" && !filters.tools) return false;
    if (item.kind === "message" && !filters.messages) return false;
    if (item.ownerId === SYNTHETIC_ROOT_ID && !filters.root) return false;
    if (item.kind !== "message" && !filters[normalizeStatus(item.status)]) return false;

    if (!query) return true;
    return item.searchText.includes(query);
}

function laneMatchesFilters(lane: ActivityLane, filters: FilterState, query: string, items: ActivityItem[]): boolean {
    if (lane.kind === "root" && !filters.root) return false;
    if (query && lane.searchText.includes(query)) return true;
    if (lane.kind === "subagent" && filters.subagents && !query) return true;
    return items.length > 0;
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
    const isSelected = selectionKey(selection) === rowSelectionKey(item);
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
            {showOwner && item.kind !== "subagent" && (
                <span className="owner-pill">{item.ownerLabel}</span>
            )}
            <span className="activity-ts">{fmtTime(item.ts)}</span>
        </button>
    );
}

function GroupedLaneView({
    lanes,
    filters,
    query,
    selection,
    onSelect,
}: {
    lanes: ActivityLane[];
    filters: FilterState;
    query: string;
    selection: Selection;
    onSelect: (selection: Selection) => void;
}) {
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

    const visible = useMemo(() => {
        return lanes
            .map((lane) => {
                const visibleItems = lane.items.filter((item) => matchesItemFilters(item, filters, query));
                return { lane, visibleItems };
            })
            .filter(({ lane, visibleItems }) => laneMatchesFilters(lane, filters, query, visibleItems));
    }, [filters, lanes, query]);

    if (visible.length === 0) {
        return <div className="activity-empty">No grouped matches for current filters.</div>;
    }

    return (
        <div className="lane-list">
            {visible.map(({ lane, visibleItems }) => {
                const isCollapsed = collapsed[lane.id] ?? false;
                const laneSelected = selection?.kind === "subagent" && selection.id === lane.id;
                const hasSelectedChild = visibleItems.some((item) => rowSelectionKey(item) === selectionKey(selection));
                const laneClass = [
                    "lane",
                    lane.kind === "root" ? "lane-root" : "",
                    laneSelected || hasSelectedChild ? "selected-lane" : "",
                ].filter(Boolean).join(" ");

                return (
                    <section key={lane.id} className={laneClass}>
                        <div
                            className="lane-header"
                            onClick={lane.kind === "subagent" ? () => onSelect({ kind: "subagent", id: lane.id }) : undefined}
                        >
                            <div className="lane-title-wrap">
                                <div className="lane-title-row">
                                    <span className={`activity-icon ${statusClass(lane.status)}`}>
                                        {lane.kind === "root" ? "🧭" : statusIcon(lane.status)}
                                    </span>
                                    <span className="lane-title">{lane.title}</span>
                                    {lane.kind === "subagent" && (
                                        <span className={`lane-status ${statusClass(lane.status)}`}>{normalizeStatus(lane.status)}</span>
                                    )}
                                </div>
                                <div className="lane-subtitle">{lane.subtitle}</div>
                            </div>
                            <div className="lane-meta">
                                <span className="summary-chip">{lane.toolCount} tool</span>
                                <span className="summary-chip">{lane.messageCount} msg</span>
                                {lane.orphanCount > 0 && <span className="summary-chip summary-chip-warn">{lane.orphanCount} orphan</span>}
                                <span className="activity-ts">{fmtTime(lane.lastTs)}</span>
                                <button
                                    type="button"
                                    className="collapse-button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setCollapsed((current) => ({ ...current, [lane.id]: !isCollapsed }));
                                    }}
                                >
                                    {isCollapsed ? "Expand" : "Collapse"}
                                </button>
                            </div>
                        </div>

                        {!isCollapsed && (
                            <div className="lane-body">
                                {visibleItems.length > 0 ? (
                                    visibleItems.map((item) => (
                                        <EventRow
                                            key={rowSelectionKey(item)}
                                            item={item}
                                            selection={selection}
                                            onSelect={onSelect}
                                            showOwner={false}
                                        />
                                    ))
                                ) : (
                                    <div className="lane-empty">No matching child activity in this lane.</div>
                                )}
                            </div>
                        )}
                    </section>
                );
            })}
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
                    key={rowSelectionKey(item)}
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
    snapshot,
    selection,
    onSelect,
}: {
    snapshot: Snapshot;
    selection: Selection;
    onSelect: (selection: Selection) => void;
}) {
    const [viewMode, setViewMode] = useState<ViewMode>("grouped");
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

    const model = useMemo(() => buildActivityModel(snapshot), [snapshot]);
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
                            className={`segmented-button ${viewMode === "grouped" ? "active" : ""}`}
                            onClick={() => setViewMode("grouped")}
                        >
                            Grouped lanes
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
                            placeholder="Search messages, tools, owners…"
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

            {viewMode === "grouped" ? (
                <GroupedLaneView
                    lanes={model.lanes}
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

function DetailPane({ snapshot, selection }: { snapshot: Snapshot; selection: Selection }) {
    const subagentMap = new Map(snapshot.subagents.map((record) => [record.id, record]));
    const toolCallMap = new Map(snapshot.toolCalls.map((record) => [record.id, record]));

    function ownerLabel(parentToolCallId: string | undefined): string {
        const ownership = resolveOwnership(parentToolCallId, subagentMap, toolCallMap);
        if (ownership.ownerId === SYNTHETIC_ROOT_ID) {
            return ownership.orphan ? "root session (orphan chain)" : "root session";
        }
        return subagentMap.get(ownership.ownerId)?.agentDisplayName
            || subagentMap.get(ownership.ownerId)?.agentName
            || shortId(ownership.ownerId);
    }

    if (!selection) {
        return <div className="detail-empty">Select lane, tool, or message to inspect details.</div>;
    }

    if (selection.kind === "subagent") {
        const record = snapshot.subagents.find((subagent) => subagent.id === selection.id);
        if (!record) return <div className="detail-empty">Subagent not found.</div>;

        const ownedTools = snapshot.toolCalls.filter((tool) => resolveOwnership(tool.parentToolCallId, subagentMap, toolCallMap).ownerId === record.id);
        const ownedMessages = snapshot.messages.filter((message) => resolveOwnership(message.parentToolCallId, subagentMap, toolCallMap).ownerId === record.id);

        return (
            <div className="detail-content">
                <h3>{statusIcon(record.status)} {record.agentDisplayName || record.agentName}</h3>
                <FieldTable fields={[
                    ["ID", shortId(record.id)],
                    ["Agent Name", record.agentName],
                    ["Status", record.status],
                    ["Started", fmtTime(record.startedAt)],
                    ["Completed", fmtTime(record.completedAt)],
                    ["Failed", record.failedAt ? fmtTime(record.failedAt) : undefined],
                    ["Duration", fmtDuration(record.durationMs)],
                    ["Owned Tools", ownedTools.length.toString()],
                    ["Owned Messages", ownedMessages.length.toString()],
                    ["Tool Calls", record.totalToolCalls?.toString()],
                    ["Tokens", record.totalTokens?.toString()],
                ]} />
                {record.agentDescription && (
                    <div className="detail-section">
                        <h4>Description</h4>
                        <p className="detail-text">{record.agentDescription}</p>
                    </div>
                )}
                {record.error && (
                    <div className="detail-section detail-error">
                        <h4>Error</h4>
                        <pre className="detail-pre">{record.error}</pre>
                    </div>
                )}
                {ownedTools.length > 0 && (
                    <div className="detail-section">
                        <h4>Owned Tools</h4>
                        <div className="child-list">
                            {ownedTools.slice(0, 20).map((tool) => (
                                <div key={tool.id} className="child-row">
                                    <span className={statusClass(tool.status)}>{statusIcon(tool.status)}</span>
                                    <span>{tool.toolName || shortId(tool.id)}</span>
                                </div>
                            ))}
                        </div>
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
                <FieldTable fields={[
                    ["ID", shortId(record.id)],
                    ["Tool", record.toolName],
                    ["Owner Lane", ownerLabel(record.parentToolCallId)],
                    ["Parent", record.parentToolCallId === SYNTHETIC_ROOT_ID ? "root session" : shortId(record.parentToolCallId)],
                    ["Status", record.status],
                    ["Success", record.success != null ? String(record.success) : undefined],
                    ["Started", fmtTime(record.startedAt)],
                    ["Completed", fmtTime(record.completedAt)],
                ]} />
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
            </div>
        );
    }

    const record = snapshot.messages.find((message) => message.id === selection.id);
    if (!record) return <div className="detail-empty">Message not found.</div>;

    return (
        <div className="detail-content">
            <h3>💬 Assistant Message</h3>
            <FieldTable fields={[
                ["ID", shortId(record.id)],
                ["Owner Lane", ownerLabel(record.parentToolCallId)],
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

            {!error && snapshot && hasData && (
                <>
                    <OverviewCards stats={snapshot.stats} subagents={snapshot.subagents} />
                    <div className="panels">
                        <section className="panel-list">
                            <div className="panel-header">Activity</div>
                            <ActivityWorkspace snapshot={snapshot} selection={selection} onSelect={setSelection} />
                        </section>
                        <section className="panel-detail">
                            <div className="panel-header">Details</div>
                            <DetailPane snapshot={snapshot} selection={selection} />
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
