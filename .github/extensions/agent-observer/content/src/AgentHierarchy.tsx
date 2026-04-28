/**
 * Agent Hierarchy panel — shows subagent parent/child relationships
 * as a collapsible card tree.
 */

import React, { useState, useMemo } from "react";
import type { ActivityModel, Selection, FilterState, HierarchyAgentNode } from "./types.js";
import { UNAVAILABLE_FROM_EVENT_STREAM } from "./types.js";
import { shortId, fmtDuration, statusIcon, statusClass, normalizeStatus, titleCase, pluralize, selectionKey } from "./helpers.js";
import { inferDurationMsForNode, getRecentActivityPreview, selectionForNode, buildAgentHierarchy } from "./model.js";

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
