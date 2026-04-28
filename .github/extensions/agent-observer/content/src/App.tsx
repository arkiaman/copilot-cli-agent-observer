/**
 * App shell — top-level layout, data fetching, and error boundary.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Snapshot, Selection, Stats, SubagentRecord, FatalBoundaryState, FilterState, FilterKey } from "./types.js";
import { buildActivityModel, buildAgentHierarchy, selectionExists } from "./model.js";
import { ActivityWorkspace } from "./ActivityWorkspace.js";
import { AgentHierarchyPanel } from "./AgentHierarchy.js";
import { DetailPane } from "./DetailPane.js";

/* ── OverviewCards ──────────────────────────────────────────────────────── */

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

                    <section className="hierarchy-section">
                        <AgentHierarchyPanel
                            model={model}
                            selection={selection}
                            onSelect={setSelection}
                            filters={{ subagents: true, tools: true, messages: true, running: true, complete: true, failed: true, root: true }}
                            query=""
                        />
                    </section>

                    <div className="panels">
                        <section className="panel-list">
                            <div className="panel-header">Background Activity</div>
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
