/**
 * Detail pane — shows selected node context, lineage, and raw data.
 */

import React, { useState, useEffect, useRef } from "react";
import type { Snapshot, ActivityModel, Selection, ExecutionNode, DetailHeroPill, ToolCallRecord, AssistantMessageRecord } from "./types.js";
import { SYNTHETIC_ROOT_ID, UNAVAILABLE_FROM_EVENT_STREAM } from "./types.js";
import { shortId, fmtTime, fmtDuration, statusIcon, statusClass, safeText, previewText, pluralize, extractNamedText, toPromptBlock } from "./helpers.js";
import { parseNodeKey } from "./helpers.js";
import {
    selectionToStructuralNodeKey,
    collectDescendantNodes,
    getNodeTitleByKey,
    getNodeDescription,
    getNodeModelLabel,
    getNodeTypeLabel,
    getNodePromptText,
    formatNodeStatusSummary,
    formatToolRecordStatusSummary,
    getRecentActivityNodes,
    inferDurationMsForNode,
} from "./model.js";

/* ── Lazy detail loading ─────────────────────────────────────────────────── */

/** Fetch full record detail on-demand (avoids sending heavy fields in snapshot). */
function useRecordDetail<T>(kind: string | null, id: string | null): T | null {
    const [detail, setDetail] = useState<T | null>(null);
    const cacheRef = useRef<Map<string, T>>(new Map());

    useEffect(() => {
        if (!kind || !id) { setDetail(null); return; }
        const cacheKey = `${kind}:${id}`;
        const cached = cacheRef.current.get(cacheKey);
        if (cached) { setDetail(cached); return; }

        let cancelled = false;
        copilot.getRecordDetail(kind, id).then((raw) => {
            if (cancelled) return;
            try {
                const parsed = JSON.parse(raw) as T | null;
                if (parsed) {
                    // Bounded cache: evict oldest if > 20 entries
                    if (cacheRef.current.size > 20) {
                        const first = cacheRef.current.keys().next().value;
                        if (first) cacheRef.current.delete(first);
                    }
                    cacheRef.current.set(cacheKey, parsed);
                }
                setDetail(parsed);
            } catch { setDetail(null); }
        }).catch(() => { if (!cancelled) setDetail(null); });

        return () => { cancelled = true; };
    }, [kind, id]);

    return detail;
}

/* ── Shared sub-components ──────────────────────────────────────────────── */

export function ExpandablePre({ text, limit = 500, className = "detail-pre" }: { text: string; limit?: number; className?: string }) {
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

/* ── DetailPane ─────────────────────────────────────────────────────────── */

export function DetailPane({
    snapshot,
    model,
    selection,
}: {
    snapshot: Snapshot;
    model: ActivityModel;
    selection: Selection;
}) {
    // Hooks must be called unconditionally (React rules of hooks)
    const fullToolDetail = useRecordDetail<ToolCallRecord>(
        selection?.kind === "toolcall" ? "toolcall" : null,
        selection?.kind === "toolcall" ? selection.id : null,
    );
    const fullMessageDetail = useRecordDetail<AssistantMessageRecord>(
        selection?.kind === "message" ? "message" : null,
        selection?.kind === "message" ? selection.id : null,
    );

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
                    title={`🧭 ${rootNode?.title || "Root session"}`}
                    subtitle={rootNode?.subtitle || "Foreground session + orphan activity"}
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
                    ["Desc", rootNode?.subtitle || "Foreground session + orphan activity"],
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
        // Use full detail for arguments if loaded, fall back to lean snapshot field
        const fullArgs = fullToolDetail?.arguments ?? record.arguments;
        const fullResult = fullToolDetail?.resultPreview ?? record.resultPreview ?? record.resultSnippet;
        const promptFromArguments = extractNamedText(fullArgs, ["prompt", "description", "task", "goal", "query", "message", "content", "input", "request"]);
        const promptText = structuralNode
            ? getNodePromptText(model, structuralNode)
            : (promptFromArguments ? toPromptBlock(promptFromArguments) : UNAVAILABLE_FROM_EVENT_STREAM);
        const modelText = extractNamedText(fullArgs, ["model", "modelName", "overrideModel", "override_model"]);
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

                {fullArgs != null && (
                    <DetailDisclosure title="Arguments" defaultOpen={true}>
                        <ExpandablePre
                            text={typeof fullArgs === "string" ? fullArgs : JSON.stringify(fullArgs, null, 2)}
                            limit={1500}
                        />
                    </DetailDisclosure>
                )}

                {fullResult != null && (
                    <DetailDisclosure title="Result Preview" defaultOpen={true}>
                        <ExpandablePre text={fullResult} limit={1000} />
                    </DetailDisclosure>
                )}
            </div>
        );
    }

    const record = snapshot.messages.find((message) => message.id === selection.id);
    if (!record) return <div className="detail-empty">Message not found.</div>;
    // Use full detail for content/reasoning if loaded, fall back to lean preview
    const fullContent = fullMessageDetail?.content ?? record.contentPreview ?? record.content;
    const fullReasoning = fullMessageDetail?.reasoningText ?? record.reasoningPreview ?? record.reasoningText;

    return (
        <div className="detail-content">
            <DetailHero
                kicker="Background Task Detail"
                title={`💬 ${previewText(safeText(fullContent) || "(empty)", 88)}`}
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
                ["Prompt", previewText(safeText(fullContent), 100) || UNAVAILABLE_FROM_EVENT_STREAM],
            ]} />

            <div className="detail-section">
                <h4>Prompt (first 10 lines)</h4>
                <ExpandablePre text={fullContent ? toPromptBlock(fullContent) : UNAVAILABLE_FROM_EVENT_STREAM} limit={800} />
            </div>

            <div className="detail-section">
                <h4>Recent Activity</h4>
                <ChildNodeList nodes={[]} emptyText="No child activity for messages." />
            </div>

            <DetailDisclosure title="Observer Context">
                <FieldTable fields={[
                    ["Branch", getNodeTitleByKey(model.nodesByKey, structuralNode?.parentKey)],
                    ["Parent", record.parentToolCallId === SYNTHETIC_ROOT_ID ? "root session" : shortId(record.parentToolCallId)],
                    ["Tool Requests", record.toolRequestCount?.toString()],
                    ["Time", fmtTime(record.timestamp)],
                ]} />
                <div className="detail-section">
                    <h4>Lineage</h4>
                    <Breadcrumbs pathKeys={pathKeys} model={model} />
                </div>
            </DetailDisclosure>

            {fullContent && (
                <DetailDisclosure title="Content" defaultOpen={true}>
                    <ExpandablePre text={fullContent} limit={1000} />
                </DetailDisclosure>
            )}

            {record.reasoningAvailability !== "unsupported" && (
                <DetailDisclosure title="Reasoning" defaultOpen={true}>
                    <ReasoningSection availability={record.reasoningAvailability} text={fullReasoning} />
                </DetailDisclosure>
            )}
        </div>
    );
}
