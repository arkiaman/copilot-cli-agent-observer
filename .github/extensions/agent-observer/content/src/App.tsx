/**
 * App shell — top-level layout, data fetching, and error boundary.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Snapshot, Selection, Stats, SubagentRecord, FatalBoundaryState, FilterState, FilterKey } from "./types.js";
import { SYNTHETIC_ROOT_ID } from "./types.js";
import { buildActivityModel, buildAgentHierarchy, selectionExists } from "./model.js";
import { ActivityWorkspace } from "./ActivityWorkspace.js";
import { AgentHierarchyPanel } from "./AgentHierarchy.js";
import { DetailPane } from "./DetailPane.js";

/* ── Section layout persistence ─────────────────────────────────────────── */

const LAYOUT_KEY = "agent-observer:section-layout";

type SectionId = "hierarchy" | "activity" | "details";

type SectionLayout = Record<SectionId, boolean>;

const DEFAULT_LAYOUT: SectionLayout = { hierarchy: false, activity: true, details: true };

function loadLayout(): SectionLayout {
    try {
        const raw = localStorage.getItem(LAYOUT_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return { ...DEFAULT_LAYOUT, ...parsed };
        }
    } catch { /* ignore */ }
    return { ...DEFAULT_LAYOUT };
}

function useSectionLayout() {
    const [layout, setLayout] = useState<SectionLayout>(loadLayout);

    const toggle = useCallback((id: SectionId) => {
        setLayout((prev) => {
            const next = { ...prev, [id]: !prev[id] };
            try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
            return next;
        });
    }, []);

    return { layout, toggle };
}

/* ── Panel sizes persistence (drag-to-resize) ──────────────────────────── */

const SIZES_KEY = "agent-observer:panel-sizes";

interface PanelSizes {
    /** Hierarchy section height as percentage of workspace-shell (0–100) */
    hierarchyPct: number;
    /** Activity panel width as percentage of the panels row (0–100) */
    activityPct: number;
}

const DEFAULT_SIZES: PanelSizes = { hierarchyPct: 30, activityPct: 60 };

function loadSizes(): PanelSizes {
    try {
        const raw = localStorage.getItem(SIZES_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return {
                hierarchyPct: clampPct(parsed.hierarchyPct ?? DEFAULT_SIZES.hierarchyPct),
                activityPct: clampPct(parsed.activityPct ?? DEFAULT_SIZES.activityPct),
            };
        }
    } catch { /* ignore */ }
    return { ...DEFAULT_SIZES };
}

function clampPct(v: number): number {
    return Math.max(10, Math.min(90, v));
}

function usePanelSizes() {
    const [sizes, setSizes] = useState<PanelSizes>(loadSizes);

    const update = useCallback((partial: Partial<PanelSizes>) => {
        setSizes((prev) => {
            const next = {
                hierarchyPct: clampPct(partial.hierarchyPct ?? prev.hierarchyPct),
                activityPct: clampPct(partial.activityPct ?? prev.activityPct),
            };
            try { localStorage.setItem(SIZES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
            return next;
        });
    }, []);

    return { sizes, updateSizes: update };
}

/* ── ResizeHandle — drag-to-resize between sections ────────────────────── */

const MIN_PX = 80;

function ResizeHandle({
    direction,
    containerRef,
    onResize,
}: {
    direction: "horizontal" | "vertical";
    containerRef: React.RefObject<HTMLElement | null>;
    onResize: (pct: number) => void;
}) {
    const handleRef = useRef<HTMLDivElement | null>(null);
    const dragging = useRef(false);

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        dragging.current = true;

        const target = e.currentTarget as HTMLElement;
        target.setPointerCapture(e.pointerId);

        const cursor = direction === "vertical" ? "row-resize" : "col-resize";
        document.body.style.cursor = cursor;
        document.body.style.userSelect = "none";

        const handleMove = (ev: PointerEvent) => {
            if (!dragging.current || !containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();

            let pct: number;
            if (direction === "vertical") {
                const total = rect.height;
                const offset = ev.clientY - rect.top;
                if (total < MIN_PX * 2) return;
                pct = clampPct((offset / total) * 100);
                if (offset < MIN_PX) pct = clampPct((MIN_PX / total) * 100);
                if (total - offset < MIN_PX) pct = clampPct(((total - MIN_PX) / total) * 100);
            } else {
                const total = rect.width;
                const offset = ev.clientX - rect.left;
                if (total < MIN_PX * 2) return;
                pct = clampPct((offset / total) * 100);
                if (offset < MIN_PX) pct = clampPct((MIN_PX / total) * 100);
                if (total - offset < MIN_PX) pct = clampPct(((total - MIN_PX) / total) * 100);
            }
            onResize(pct);
        };

        const cleanup = () => {
            dragging.current = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            target.removeEventListener("pointermove", handleMove);
            target.removeEventListener("pointerup", cleanup);
            target.removeEventListener("pointercancel", cleanup);
            target.removeEventListener("lostpointercapture", cleanup);
        };

        target.addEventListener("pointermove", handleMove);
        target.addEventListener("pointerup", cleanup);
        target.addEventListener("pointercancel", cleanup);
        target.addEventListener("lostpointercapture", cleanup);
    }, [direction, containerRef, onResize]);

    return (
        <div
            className={`resize-handle resize-handle-${direction}`}
            onPointerDown={onPointerDown}
            role="separator"
            aria-orientation={direction === "vertical" ? "horizontal" : "vertical"}
        />
    );
}

/* ── CollapsibleSection — reusable section with header toggle ──────────── */

function CollapsibleSection({
    id,
    title,
    open,
    onToggle,
    className,
    style,
    children,
}: {
    id: SectionId;
    title: string;
    open: boolean;
    onToggle: (id: SectionId) => void;
    className?: string;
    style?: React.CSSProperties;
    children: React.ReactNode;
}) {
    return (
        <section className={`collapsible-section ${className ?? ""} ${open ? "section-open" : "section-closed"}`} style={style}>
            <button
                type="button"
                className="section-toggle-header"
                onClick={() => onToggle(id)}
                aria-expanded={open}
            >
                <span className="section-toggle-icon">{open ? "▾" : "▸"}</span>
                <span className="section-toggle-title">{title}</span>
            </button>
            {open && children}
        </section>
    );
}

/* ── OverviewCards ──────────────────────────────────────────────────────── */

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

/* ── FatalBoundary ──────────────────────────────────────────────────────── */

export class FatalBoundary extends React.Component<React.PropsWithChildren, FatalBoundaryState> {
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

/* ── App ────────────────────────────────────────────────────────────────── */

export function App() {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selection, setSelection] = useState<Selection>(null);
    const lastRawRef = useRef<string | null>(null);

    // Shared filter/search state — drives both hierarchy and activity
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
        setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
    }, []);

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

    // Auto-select root whenever selection is null so the details pane is never empty
    useEffect(() => {
        if (model && !selection) {
            setSelection({ kind: "root", id: SYNTHETIC_ROOT_ID });
        }
    }, [model, selection]);

    const { layout, toggle } = useSectionLayout();
    const { sizes, updateSizes } = usePanelSizes();

    // Refs for resize containers
    const workspaceRef = useRef<HTMLDivElement | null>(null);
    const panelsRef = useRef<HTMLDivElement | null>(null);

    // Computed styles driven by sizes + collapse state
    const hierarchyOpen = layout.hierarchy;
    const activityOpen = layout.activity;
    const detailsOpen = layout.details;

    const hierarchyStyle: React.CSSProperties = hierarchyOpen
        ? { flex: `0 0 ${sizes.hierarchyPct}%`, minHeight: MIN_PX, overflow: "hidden" }
        : {};
    const panelsStyle: React.CSSProperties = {
        flex: hierarchyOpen ? `1 1 ${100 - sizes.hierarchyPct}%` : "1 1 100%",
        minHeight: MIN_PX,
    };
    const activityStyle: React.CSSProperties = activityOpen
        ? { width: detailsOpen ? `${sizes.activityPct}%` : "100%", minWidth: MIN_PX }
        : {};
    const detailStyle: React.CSSProperties = detailsOpen
        ? { flex: 1, minWidth: MIN_PX }
        : {};

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

            {!error && snapshot && model && (
                <>
                    <OverviewCards stats={snapshot.stats} subagents={snapshot.subagents} />

                    <div className="workspace-shell" ref={workspaceRef}>
                        <CollapsibleSection id="hierarchy" title="Agent Hierarchy" open={hierarchyOpen} onToggle={toggle} className="hierarchy-section" style={hierarchyStyle}>
                            <AgentHierarchyPanel
                                model={model}
                                selection={selection}
                                onSelect={setSelection}
                                filters={filters}
                                query={query}
                            />
                        </CollapsibleSection>

                        {hierarchyOpen && (
                            <ResizeHandle
                                direction="vertical"
                                containerRef={workspaceRef}
                                onResize={(pct) => updateSizes({ hierarchyPct: pct })}
                            />
                        )}

                        <div className="panels" ref={panelsRef} style={panelsStyle}>
                            <CollapsibleSection id="activity" title="Background Activity" open={activityOpen} onToggle={toggle} className="panel-list" style={activityStyle}>
                                <ActivityWorkspace
                                    model={model}
                                    selection={selection}
                                    onSelect={setSelection}
                                    search={search}
                                    onSearchChange={setSearch}
                                    filters={filters}
                                    onToggleFilter={toggleFilter}
                                    query={query}
                                />
                            </CollapsibleSection>

                            {activityOpen && detailsOpen && (
                                <ResizeHandle
                                    direction="horizontal"
                                    containerRef={panelsRef}
                                    onResize={(pct) => updateSizes({ activityPct: pct })}
                                />
                            )}

                            <CollapsibleSection id="details" title="Subagent Details" open={detailsOpen} onToggle={toggle} className="panel-detail" style={detailStyle}>
                                <DetailPane snapshot={snapshot} model={model} selection={selection} />
                            </CollapsibleSection>
                        </div>
                    </div>
                </>
            )}
        </>
    );
}
