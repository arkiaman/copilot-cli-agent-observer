/**
 * Agent Hierarchy panel — shows subagent parent/child relationships
 * as a visual graph with connector lines.
 */

import React, { useState, useMemo } from "react";
import type { ActivityModel, Selection, FilterState, HierarchyAgentNode } from "./types.js";
import { UNAVAILABLE_FROM_EVENT_STREAM } from "./types.js";
import { shortId, fmtDuration, statusIcon, statusClass, normalizeStatus, titleCase, pluralize, selectionKey } from "./helpers.js";
import { inferDurationMsForNode, getRecentActivityPreview, selectionForNode, buildAgentHierarchy } from "./model.js";

/* ── HierarchyCard — a single node in the graph ───────────────────────── */

export function HierarchyCard({
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
    const expanded = query ? true : (manualExpanded ?? defaultExpanded);

    const displayName = isRoot
        ? "Main agent"
        : (record?.agentDisplayName || record?.agentName || shortId(node.id));
    const statusText = isRoot ? null : titleCase(normalizeStatus(node.status));
    const icon = isRoot ? "🧭" : statusIcon(node.status);
    const sClass = isRoot ? "" : statusClass(node.status);
    const durationMs = isRoot ? undefined : inferDurationMsForNode(model, node);
    const eventCount = node.descendantCount;

    const handleClick = () => onSelect(selectionForNode(node));

    return (
        <div className={`hg-node ${isRoot ? "hg-node-root" : ""} ${hasChildren ? "hg-node-parent" : "hg-node-leaf"}`}>
            <button
                type="button"
                className={`hg-card ${isRoot ? "hg-card-root" : ""} ${isSelected ? "selected" : ""} ${sClass}`}
                onClick={handleClick}
                title={displayName}
            >
                <div className="hg-card-header">
                    <span className={`hg-card-icon ${sClass}`}>{icon}</span>
                    <span className="hg-card-name">{displayName}</span>
                    {statusText && <span className={`hg-card-badge ${sClass}`}>{statusText}</span>}
                </div>
                <div className="hg-card-body">
                    {durationMs != null && <span className="hg-card-duration">{fmtDuration(durationMs)}</span>}
                    <span className="hg-card-counts">{pluralize(eventCount, "descendant")}</span>
                    {!isRoot && record?.totalToolCalls != null && (
                        <span className="hg-card-tools">{record.totalToolCalls} tools</span>
                    )}
                </div>
                {recentPreview && (
                    <div className="hg-card-recent">{recentPreview}</div>
                )}
            </button>

            {hasChildren && !expanded && (
                <button
                    type="button"
                    className="hg-expand-toggle"
                    onClick={(e) => { e.stopPropagation(); setManualExpanded(true); }}
                >
                    ▸ {children.length} child{children.length !== 1 ? "ren" : ""}
                </button>
            )}

            {hasChildren && expanded && (
                <>
                    {!isRoot && (
                        <button
                            type="button"
                            className="hg-expand-toggle"
                            onClick={(e) => { e.stopPropagation(); setManualExpanded(false); }}
                        >
                            ▾ collapse
                        </button>
                    )}
                    <div className="hg-children">
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
                </>
            )}
        </div>
    );
}

/* ── AgentHierarchyPanel — the full hierarchy section ─────────────────── */

export function AgentHierarchyPanel({
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
        <div className={`hg-panel ${isOpen ? "hg-panel-open" : "hg-panel-closed"}`}>
            <button
                type="button"
                className="hg-panel-header"
                onClick={() => {
                    if (query) return;
                    setPanelOpen((v) => !(v ?? hasSubagents));
                }}
            >
                <span className="hg-panel-toggle">{isOpen ? "▾" : "▸"}</span>
                <span className="hg-panel-title">Agent Hierarchy</span>
                <span className="hg-panel-count">{model.subagentMap.size} subagent{model.subagentMap.size !== 1 ? "s" : ""}</span>
            </button>
            {isOpen && (
                <div className="hg-graph">
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