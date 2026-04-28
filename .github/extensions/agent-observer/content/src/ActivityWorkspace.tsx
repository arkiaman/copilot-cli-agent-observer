/**
 * Activity workspace — tree and timeline views for background execution activity.
 */

import React, { useState, useCallback, useMemo } from "react";
import type { ActivityItem, ActivityModel, Selection, FilterState, FilterKey, ViewMode, VisibleTreeNode, ExecutionNode } from "./types.js";
import { UNAVAILABLE_FROM_EVENT_STREAM } from "./types.js";
import { shortId, fmtTime, statusIcon, statusClass, selectionKey, itemSelectionKey } from "./helpers.js";
import {
    selectionToStructuralNodeKey,
    selectionForNode,
    matchesItemFilters,
    buildVisibleTree,
    getNodeDescription,
    getNodeModelLabel,
    getNodeTypeLabel,
    formatNodeStatusSummary,
    getRecentActivityPreview,
} from "./model.js";


/* ── EventRow ───────────────────────────────────────────────────────────── */

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

/* ── TreeBranch ─────────────────────────────────────────────────────────── */

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

/* ── ExecutionTreeView ──────────────────────────────────────────────────── */

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
        const hasAnyNodes = model.nodesByKey.size > 1; // root always exists
        return (
            <div className="activity-empty">
                {hasAnyNodes
                    ? "No tree nodes match the current filters."
                    : "Waiting for activity from the main agent or subagents…"}
            </div>
        );
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

/* ── FlatTimelineView ───────────────────────────────────────────────────── */

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
        const hasAnyItems = items.length > 0;
        return (
            <div className="activity-empty">
                {hasAnyItems
                    ? "No chronological matches for current filters."
                    : "Waiting for activity from the main agent or subagents…"}
            </div>
        );
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

/* ── FilterButton ───────────────────────────────────────────────────────── */

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

/* ── ActivityWorkspace ──────────────────────────────────────────────────── */

export function ActivityWorkspace({
    model,
    selection,
    onSelect,
    search,
    onSearchChange,
    filters,
    onToggleFilter,
    query,
}: {
    model: ActivityModel;
    selection: Selection;
    onSelect: (selection: Selection) => void;
    search: string;
    onSearchChange: (value: string) => void;
    filters: FilterState;
    onToggleFilter: (key: FilterKey) => void;
    query: string;
}) {
    const [viewMode, setViewMode] = useState<ViewMode>("tree");

    const visibleTree = useMemo(
        () => buildVisibleTree(model, model.rootNodeKey, filters, query),
        [filters, model, query],
    );

    const clearSearch = useCallback(() => onSearchChange(""), [onSearchChange]);

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
                            onChange={(event) => onSearchChange(event.target.value)}
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
                        <FilterButton active={filters.subagents} label="Subagents" onClick={() => onToggleFilter("subagents")} />
                        <FilterButton active={filters.tools} label="Tools" onClick={() => onToggleFilter("tools")} />
                        <FilterButton active={filters.messages} label="Messages" onClick={() => onToggleFilter("messages")} />
                    </div>
                    <div className="filter-group">
                        <span className="filter-label">Status</span>
                        <FilterButton active={filters.running} label="Running" onClick={() => onToggleFilter("running")} />
                        <FilterButton active={filters.complete} label="Complete" onClick={() => onToggleFilter("complete")} />
                        <FilterButton active={filters.failed} label="Failed" onClick={() => onToggleFilter("failed")} />
                        <FilterButton active={filters.root} label="Root / orphan" onClick={() => onToggleFilter("root")} />
                    </div>
                </div>
            </div>

            {viewMode === "tree" ? (
                <ExecutionTreeView
                    model={model}
                    visibleTree={visibleTree}
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
