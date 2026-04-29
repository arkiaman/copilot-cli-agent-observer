/**
 * Shared types, interfaces, and constants for the Agent Observer UI.
 */

declare global {
    const copilot: {
        log: (msg: string, opts?: unknown) => Promise<void>;
        getSnapshot: () => Promise<string>;
        getRevision: () => Promise<string>;
        getRecordDetail: (kind: string, id: string) => Promise<string>;
    };
}

export interface SubagentRecord {
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

export interface ToolCallRecord {
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
    // Lean snapshot fields (replace full arguments/resultPreview)
    argSummary?: string;
    resultSnippet?: string;
}

export interface AssistantMessageRecord {
    id: string;
    parentToolCallId: string;
    content: string;
    toolRequestCount: number;
    reasoningAvailability: "available" | "empty" | "unsupported";
    reasoningText?: string;
    timestamp: string;
    _lastEventTs: string;
    // Lean snapshot fields (replace full content/reasoningText)
    contentPreview?: string;
    contentLength?: number;
    reasoningPreview?: string;
}

export interface Stats {
    subagentCount: number;
    toolCallCount: number;
    messageCount: number;
    ingestedEventCount: number;
    orphanToolCallCount: number;
}

export interface TimelineRef {
    kind: "subagent" | "toolcall" | "message";
    id: string;
}

export interface ExecutionGraphSnapshot {
    rootNodeKey: string;
    nodeParentKeys: Record<string, string | null>;
    childNodeKeys: Record<string, string[]>;
    pathNodeKeys: Record<string, string[]>;
    descendantCounts: Record<string, number>;
    orphanNodeKeys: string[];
    hiddenToolCallIds?: string[];
}

export interface SessionMeta {
    label: string;
    cwdName: string;
    cwdPath: string;
    branch: string | null;
    pid: number;
    startedAt: string;
    workspacePath: string | null;
}

export interface Snapshot {
    revision?: number;
    subagents: SubagentRecord[];
    toolCalls: ToolCallRecord[];
    messages: AssistantMessageRecord[];
    toolCallsByParent?: Record<string, { toolCallId: string; toolName: string; status: string }[]>;
    executionGraph?: ExecutionGraphSnapshot;
    recentEvents?: { ts: string; type: string; summary: string }[];
    timeline: TimelineRef[];
    stats: Stats;
    sessionMeta?: SessionMeta;
}

export interface FatalBoundaryState {
    error: string | null;
}

export type Selection =
    | { kind: "root"; id: string }
    | { kind: "subagent"; id: string }
    | { kind: "toolcall"; id: string }
    | { kind: "message"; id: string }
    | null;

export type ViewMode = "tree" | "timeline";
export type StatusKey = "running" | "complete" | "failed";
export type FilterKey =
    | "subagents"
    | "tools"
    | "messages"
    | "running"
    | "complete"
    | "failed"
    | "root";
export type NodeKind = "root" | "subagent" | "toolcall" | "message";

export interface FilterState {
    subagents: boolean;
    tools: boolean;
    messages: boolean;
    running: boolean;
    complete: boolean;
    failed: boolean;
    root: boolean;
}

export interface ActivityItem {
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
    resultLine?: string;
    searchText: string;
}

export interface ExecutionNode {
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

export interface ActivityModel {
    items: ActivityItem[];
    nodesByKey: Map<string, ExecutionNode>;
    rootNodeKey: string;
    graph: ExecutionGraphSnapshot;
    subagentMap: Map<string, SubagentRecord>;
    toolCallMap: Map<string, ToolCallRecord>;
    messageMap: Map<string, AssistantMessageRecord>;
}

export interface VisibleTreeNode {
    key: string;
    matched: boolean;
    children: VisibleTreeNode[];
}

export interface DetailHeroPill {
    label: string;
    className?: string;
}

export interface HierarchyAgentNode {
    key: string;
    node: ExecutionNode;
    record: SubagentRecord | null;
    children: HierarchyAgentNode[];
    depth: number;
    recentPreview: string;
}

export const SYNTHETIC_ROOT_ID = "__root__";
export const UNAVAILABLE_FROM_EVENT_STREAM = "Unavailable from event stream";
