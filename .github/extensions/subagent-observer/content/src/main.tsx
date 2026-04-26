/**
 * Subagent Observer — MVP visualization UI
 *
 * Read-only dashboard showing:
 *   - Overview cards (stats + subagent status)
 *   - Activity timeline (subagents, tool calls, messages)
 *   - Detail pane for selected items (fields, args, results, reasoning)
 *
 * Data comes from the normalized event store via copilot.getSnapshot().
 * Auto-refreshes every 2 seconds.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";

// ── Bridge type ─────────────────────────────────────────────────────────────

declare const copilot: {
    log: (msg: string, opts?: unknown) => Promise<void>;
    getSnapshot: () => Promise<string>;
};

// ── Data model (mirrors event-model.js) ─────────────────────────────────────

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

// ── Selection type ──────────────────────────────────────────────────────────

type Selection =
    | { kind: "subagent"; id: string }
    | { kind: "toolcall"; id: string }
    | { kind: "message"; id: string }
    | null;

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Overview Cards ──────────────────────────────────────────────────────────

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

// ── Activity List (timeline) ────────────────────────────────────────────────

function ActivityList({
    snapshot,
    selection,
    onSelect,
}: {
    snapshot: Snapshot;
    selection: Selection;
    onSelect: (sel: Selection) => void;
}) {
    // Build lookup maps
    const subagentMap = useMemo(() => {
        const m = new Map<string, SubagentRecord>();
        for (const s of snapshot.subagents) m.set(s.id, s);
        return m;
    }, [snapshot.subagents]);

    const toolCallMap = useMemo(() => {
        const m = new Map<string, ToolCallRecord>();
        for (const tc of snapshot.toolCalls) m.set(tc.id, tc);
        return m;
    }, [snapshot.toolCalls]);

    const messageMap = useMemo(() => {
        const m = new Map<string, AssistantMessageRecord>();
        for (const msg of snapshot.messages) m.set(msg.id, msg);
        return m;
    }, [snapshot.messages]);

    // Timeline in reverse chronological
    const entries = useMemo(() => [...snapshot.timeline].reverse(), [snapshot.timeline]);

    if (entries.length === 0) {
        return (
            <div className="activity-empty">
                No activity yet.<br />
                Trigger a subagent run to see events here.
            </div>
        );
    }

    return (
        <div className="activity-list">
            {entries.map((ref) => {
                const isSelected = selection?.kind === ref.kind && selection?.id === ref.id;
                const cls = `activity-row ${isSelected ? "selected" : ""}`;

                if (ref.kind === "subagent") {
                    const r = subagentMap.get(ref.id);
                    if (!r) return null;
                    return (
                        <div key={`s-${ref.id}`} className={cls} onClick={() => onSelect({ kind: "subagent", id: ref.id })}>
                            <span className={`activity-icon ${statusClass(r.status)}`}>{statusIcon(r.status)}</span>
                            <span className="activity-kind">agent</span>
                            <span className="activity-name">{r.agentDisplayName || r.agentName || shortId(r.id)}</span>
                            <span className="activity-ts">{fmtTime(r.startedAt)}</span>
                        </div>
                    );
                }

                if (ref.kind === "toolcall") {
                    const r = toolCallMap.get(ref.id);
                    if (!r) return null;
                    return (
                        <div key={`tc-${ref.id}`} className={cls} onClick={() => onSelect({ kind: "toolcall", id: ref.id })}>
                            <span className={`activity-icon ${statusClass(r.status)}`}>{statusIcon(r.status)}</span>
                            <span className="activity-kind">tool</span>
                            <span className="activity-name">{r.toolName || shortId(r.id)}</span>
                            <span className="activity-ts">{fmtTime(r.startedAt)}</span>
                        </div>
                    );
                }

                if (ref.kind === "message") {
                    const r = messageMap.get(ref.id);
                    if (!r) return null;
                    return (
                        <div key={`m-${ref.id}`} className={cls} onClick={() => onSelect({ kind: "message", id: ref.id })}>
                            <span className="activity-icon">💬</span>
                            <span className="activity-kind">msg</span>
                            <span className="activity-name">
                                {r.content ? r.content.slice(0, 50) + (r.content.length > 50 ? "…" : "") : "(empty)"}
                            </span>
                            <span className="activity-ts">{fmtTime(r.timestamp)}</span>
                        </div>
                    );
                }
                return null;
            })}
        </div>
    );
}

// ── Detail Pane ─────────────────────────────────────────────────────────────

function DetailPane({ snapshot, selection }: { snapshot: Snapshot; selection: Selection }) {
    if (!selection) {
        return <div className="detail-empty">Select an item from the activity list to see details.</div>;
    }

    if (selection.kind === "subagent") {
        const r = snapshot.subagents.find((s) => s.id === selection.id);
        if (!r) return <div className="detail-empty">Subagent not found.</div>;
        // Find child tool calls
        const children = snapshot.toolCallsByParent[r.id] ?? [];
        return (
            <div className="detail-content">
                <h3>{statusIcon(r.status)} {r.agentDisplayName || r.agentName}</h3>
                <FieldTable fields={[
                    ["ID", shortId(r.id)],
                    ["Agent Name", r.agentName],
                    ["Status", r.status],
                    ["Started", fmtTime(r.startedAt)],
                    ["Completed", fmtTime(r.completedAt)],
                    ["Failed", r.failedAt ? fmtTime(r.failedAt) : undefined],
                    ["Duration", fmtDuration(r.durationMs)],
                    ["Tool Calls", r.totalToolCalls?.toString()],
                    ["Tokens", r.totalTokens?.toString()],
                ]} />
                {r.agentDescription && (
                    <div className="detail-section">
                        <h4>Description</h4>
                        <p className="detail-text">{r.agentDescription}</p>
                    </div>
                )}
                {r.error && (
                    <div className="detail-section detail-error">
                        <h4>Error</h4>
                        <pre className="detail-pre">{r.error}</pre>
                    </div>
                )}
                {children.length > 0 && (
                    <div className="detail-section">
                        <h4>Child Tool Calls ({children.length})</h4>
                        <div className="child-list">
                            {children.map((c) => (
                                <div key={c.toolCallId} className="child-row">
                                    <span className={statusClass(c.status)}>{statusIcon(c.status)}</span>
                                    <span>{c.toolName || shortId(c.toolCallId)}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    if (selection.kind === "toolcall") {
        const r = snapshot.toolCalls.find((tc) => tc.id === selection.id);
        if (!r) return <div className="detail-empty">Tool call not found.</div>;
        return (
            <div className="detail-content">
                <h3>{statusIcon(r.status)} {r.toolName || "Tool Call"}</h3>
                <FieldTable fields={[
                    ["ID", shortId(r.id)],
                    ["Tool", r.toolName],
                    ["Parent", r.parentToolCallId === SYNTHETIC_ROOT_ID ? "root session" : shortId(r.parentToolCallId)],
                    ["Status", r.status],
                    ["Success", r.success != null ? String(r.success) : undefined],
                    ["Started", fmtTime(r.startedAt)],
                    ["Completed", fmtTime(r.completedAt)],
                ]} />
                {r.arguments != null && (
                    <div className="detail-section">
                        <h4>Arguments</h4>
                        <pre className="detail-pre">{typeof r.arguments === "string" ? r.arguments : JSON.stringify(r.arguments, null, 2)}</pre>
                    </div>
                )}
                {r.resultPreview != null && (
                    <div className="detail-section">
                        <h4>Result Preview</h4>
                        <pre className="detail-pre">{r.resultPreview}</pre>
                    </div>
                )}
            </div>
        );
    }

    if (selection.kind === "message") {
        const r = snapshot.messages.find((m) => m.id === selection.id);
        if (!r) return <div className="detail-empty">Message not found.</div>;
        return (
            <div className="detail-content">
                <h3>💬 Assistant Message</h3>
                <FieldTable fields={[
                    ["ID", shortId(r.id)],
                    ["Parent", r.parentToolCallId === SYNTHETIC_ROOT_ID ? "root session" : shortId(r.parentToolCallId)],
                    ["Tool Requests", r.toolRequestCount.toString()],
                    ["Time", fmtTime(r.timestamp)],
                ]} />
                {r.content && (
                    <div className="detail-section">
                        <h4>Content</h4>
                        <pre className="detail-pre">{r.content.slice(0, 2000)}{r.content.length > 2000 ? "\n…(truncated)" : ""}</pre>
                    </div>
                )}
                <ReasoningSection availability={r.reasoningAvailability} text={r.reasoningText} />
            </div>
        );
    }

    return null;
}

// ── Reasoning section with explicit empty state ─────────────────────────────

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

// ── Field table helper ──────────────────────────────────────────────────────

function FieldTable({ fields }: { fields: [string, string | undefined][] }) {
    const visible = fields.filter(([, v]) => v != null && v !== "—" && v !== "");
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

// ── App ─────────────────────────────────────────────────────────────────────

function App() {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selection, setSelection] = useState<Selection>(null);

    const refresh = useCallback(async () => {
        try {
            const raw = await copilot.getSnapshot();
            const parsed = JSON.parse(raw);
            // Minimal shape check to avoid crashes on malformed data
            if (parsed && typeof parsed.stats === "object" && Array.isArray(parsed.timeline)) {
                setSnapshot(parsed);
                setError(null);
            } else {
                setError("Unexpected snapshot shape");
            }
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    useEffect(() => {
        refresh();
        // Guard against overlapping fetches: skip if previous is still in-flight
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
                            <div className="panel-header">Activity Timeline</div>
                            <ActivityList snapshot={snapshot} selection={selection} onSelect={setSelection} />
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

createRoot(document.getElementById("root")!).render(<App />);
