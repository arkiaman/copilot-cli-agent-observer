/**
 * event-model.js — Normalized data model for subagent visualization
 *
 * This module defines the canonical record shapes, constants, and merge helpers
 * used by the subagent-observer extension.  It is intentionally decoupled from
 * ingestion (session.on / session.getMessages) and rendering so that both can
 * import it without circular deps.
 *
 * Key design decisions (from plan.md §5):
 *   - Records are keyed by tool-call IDs from the SDK.
 *   - Events that lack `parentToolCallId` are attributed to a synthetic root.
 *   - Replay and live events merge deterministically via upsert-by-key + latest-
 *     timestamp-wins for mutable fields.
 *   - `reasoningText` is model-dependent; the model carries an explicit
 *     availability enum rather than treating null as "not yet loaded".
 *
 * @module event-model
 */

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Synthetic key used as the parentToolCallId for events that arrive without
 * one.  This groups orphan tool calls and assistant messages under a visible
 * "root session" bucket instead of silently dropping them.
 */
export const SYNTHETIC_ROOT_ID = "__root__";

/**
 * Enum-like values for `SubagentRecord.status`.
 * @readonly
 * @enum {string}
 */
export const SubagentStatus = /** @type {const} */ ({
    /** Subagent has been started but not yet completed or failed. */
    STARTED: "started",
    /** Subagent finished successfully. */
    COMPLETED: "completed",
    /** Subagent terminated with an error. */
    FAILED: "failed",
});

/**
 * Enum-like values for `ToolCallRecord.status`.
 * @readonly
 * @enum {string}
 */
export const ToolCallStatus = /** @type {const} */ ({
    /** Tool execution has started; waiting for result. */
    RUNNING: "running",
    /** Tool completed successfully. */
    COMPLETE: "complete",
    /** Tool completed with an error / success=false. */
    FAILED: "failed",
});

/**
 * Describes whether reasoning/thinking text is available for a record.
 *
 * Three-state instead of nullable boolean so the UI can distinguish
 * "we asked and there is nothing" from "this model never exposes reasoning".
 * @readonly
 * @enum {string}
 */
export const ReasoningAvailability = /** @type {const} */ ({
    /** Reasoning text is present and displayable. */
    AVAILABLE: "available",
    /** SDK delivered the field but it was empty / null. */
    EMPTY: "empty",
    /** The field was never present — model or event type does not support it. */
    UNSUPPORTED: "unsupported",
});

// ── Record factories ────────────────────────────────────────────────────────

/**
 * Represents one subagent invocation, keyed by the tool-call ID of the
 * spawning `task` tool call.
 *
 * @typedef {Object} SubagentRecord
 * @property {string}  id                - Same as the spawning toolCallId.
 * @property {string}  agentName         - Machine name (e.g. "explore").
 * @property {string}  agentDisplayName  - Human-readable label.
 * @property {string}  [agentDescription] - Optional longer description.
 * @property {SubagentStatus[keyof SubagentStatus]} status
 * @property {string}  [startedAt]       - ISO timestamp.
 * @property {string}  [completedAt]     - ISO timestamp (on success).
 * @property {string}  [failedAt]        - ISO timestamp (on failure).
 * @property {string}  [error]           - Error message when status=failed.
 * @property {number}  [totalToolCalls]  - Reported by subagent.completed.
 * @property {number}  [totalTokens]     - Reported by subagent.completed.
 * @property {number}  [durationMs]      - Reported by subagent.completed.
 * @property {string}  _lastEventTs      - Timestamp of the most recent event
 *                                          that touched this record (for merge).
 */

/**
 * Create a blank SubagentRecord with sensible defaults.
 *
 * @param {string} id - The spawning toolCallId.
 * @param {Partial<SubagentRecord>} [overrides]
 * @returns {SubagentRecord}
 */
export function createSubagentRecord(id, overrides = {}) {
    return {
        id,
        agentName: "",
        agentDisplayName: "",
        status: SubagentStatus.STARTED,
        _lastEventTs: new Date().toISOString(),
        ...overrides,
    };
}

/**
 * Represents a single tool execution, keyed by its own toolCallId.
 *
 * @typedef {Object} ToolCallRecord
 * @property {string}  id                  - The tool call's own toolCallId.
 * @property {string}  parentToolCallId    - Owner subagent's toolCallId, or
 *                                            `SYNTHETIC_ROOT_ID` if orphaned.
 * @property {string}  toolName            - e.g. "powershell", "view".
 * @property {*}       [arguments]         - Raw arguments object.
 * @property {ToolCallStatus[keyof ToolCallStatus]} status
 * @property {boolean} [success]           - Populated on completion.
 * @property {string}  [resultPreview]     - First N chars of result content.
 * @property {string}  [startedAt]         - ISO timestamp.
 * @property {string}  [completedAt]       - ISO timestamp.
 * @property {string}  _lastEventTs        - For merge arbitration.
 */

/**
 * @param {string} id
 * @param {Partial<ToolCallRecord>} [overrides]
 * @returns {ToolCallRecord}
 */
export function createToolCallRecord(id, overrides = {}) {
    return {
        id,
        parentToolCallId: SYNTHETIC_ROOT_ID,
        toolName: "",
        status: ToolCallStatus.RUNNING,
        _lastEventTs: new Date().toISOString(),
        ...overrides,
    };
}

/**
 * A single assistant message fragment attributed to a subagent (or root).
 *
 * @typedef {Object} AssistantMessageRecord
 * @property {string}  id                   - Unique ID (event ID or generated).
 * @property {string}  parentToolCallId     - Owning subagent or SYNTHETIC_ROOT_ID.
 * @property {string}  content              - Message text / markdown.
 * @property {number}  toolRequestCount     - How many tool requests were in message.
 * @property {ReasoningAvailability[keyof ReasoningAvailability]} reasoningAvailability
 * @property {string}  [reasoningText]      - Present when availability=AVAILABLE.
 * @property {string}  timestamp            - ISO timestamp.
 * @property {string}  _lastEventTs         - For merge.
 */

/**
 * @param {string} id
 * @param {Partial<AssistantMessageRecord>} [overrides]
 * @returns {AssistantMessageRecord}
 */
export function createAssistantMessageRecord(id, overrides = {}) {
    return {
        id,
        parentToolCallId: SYNTHETIC_ROOT_ID,
        content: "",
        toolRequestCount: 0,
        reasoningAvailability: ReasoningAvailability.UNSUPPORTED,
        timestamp: new Date().toISOString(),
        _lastEventTs: new Date().toISOString(),
        ...overrides,
    };
}

/**
 * Ephemeral progress note for a tool call.  Not stored long-term but may be
 * buffered briefly for live display.
 *
 * @typedef {Object} ProgressNote
 * @property {string} toolCallId
 * @property {string} message
 * @property {string} timestamp
 */

// ── Merge helpers ───────────────────────────────────────────────────────────
//
// Replay (getMessages) and live (on) events can overlap during the startup
// window.  The merge strategy is:
//   1. Key-based upsert: if a record with the same id exists, merge fields.
//   2. For mutable fields (status, completedAt, error, etc.) the value from the
//      event with the **later** _lastEventTs wins.
//   3. Immutable fields (id, agentName, toolName) are set-once; later events
//      cannot overwrite them with blanks.
//
// This gives a stable, idempotent result regardless of delivery order.

/**
 * Merge `incoming` fields into `existing`, respecting the latest-timestamp
 * rule for mutable fields and set-once semantics for identity fields.
 *
 * Returns a **new object** — does not mutate either input.
 *
 * Tie-break policy: when timestamps are equal the **existing** value is kept
 * for mutable fields, making the merge idempotent regardless of arrival order.
 *
 * @template {Record<string, any>} T
 * @param {T} existing
 * @param {Partial<T> & { _lastEventTs?: string }} incoming
 * @param {string[]} [identityFields] - Fields that should not be overwritten
 *   with empty/undefined values once set.  A current value equal to
 *   `SYNTHETIC_ROOT_ID` is treated as unset so a real value can replace it.
 * @returns {T}
 */
export function mergeRecord(existing, incoming, identityFields = []) {
    const identitySet = new Set(identityFields);
    const existingTs = existing._lastEventTs ?? "";
    const incomingTs = incoming._lastEventTs ?? "";
    const incomingIsStrictlyNewer = incomingTs > existingTs;

    /** @type {Record<string, any>} */
    const merged = { ...existing };

    for (const [key, value] of Object.entries(incoming)) {
        if (key === "id") continue; // never overwrite primary key

        if (identitySet.has(key)) {
            // Set-once: accept non-empty values when the current value is
            // empty or is the synthetic-root placeholder.
            const current = merged[key];
            const isUnset = !current || current === SYNTHETIC_ROOT_ID;
            if (isUnset && value && value !== SYNTHETIC_ROOT_ID) {
                merged[key] = value;
            }
            continue;
        }

        // Mutable field: strictly-newer timestamp wins (equal → keep existing)
        if (incomingIsStrictlyNewer && value !== undefined) {
            merged[key] = value;
        }
    }

    return /** @type {T} */ (merged);
}

/** Identity fields that should not be blanked once populated. */
const SUBAGENT_IDENTITY = ["agentName", "agentDisplayName", "agentDescription"];
const TOOL_CALL_IDENTITY = ["toolName", "parentToolCallId"];

/**
 * Upsert a SubagentRecord into a Map, applying merge rules.
 *
 * @param {Map<string, SubagentRecord>} map
 * @param {Partial<SubagentRecord> & { id: string }} incoming
 * @returns {SubagentRecord} The record now stored in the map.
 */
export function upsertSubagent(map, incoming) {
    const existing = map.get(incoming.id);
    const record = existing
        ? mergeRecord(existing, incoming, SUBAGENT_IDENTITY)
        : createSubagentRecord(incoming.id, incoming);
    map.set(record.id, record);
    return record;
}

/**
 * Upsert a ToolCallRecord into a Map, applying merge rules.
 *
 * @param {Map<string, ToolCallRecord>} map
 * @param {Partial<ToolCallRecord> & { id: string }} incoming
 * @returns {ToolCallRecord}
 */
export function upsertToolCall(map, incoming) {
    const existing = map.get(incoming.id);
    const record = existing
        ? mergeRecord(existing, incoming, TOOL_CALL_IDENTITY)
        : createToolCallRecord(incoming.id, incoming);
    map.set(record.id, record);
    return record;
}

/**
 * Upsert an AssistantMessageRecord into a Map.
 *
 * @param {Map<string, AssistantMessageRecord>} map
 * @param {Partial<AssistantMessageRecord> & { id: string }} incoming
 * @returns {AssistantMessageRecord}
 */
export function upsertAssistantMessage(map, incoming) {
    const existing = map.get(incoming.id);
    const record = existing
        ? mergeRecord(existing, incoming, ["parentToolCallId"])
        : createAssistantMessageRecord(incoming.id, incoming);
    map.set(record.id, record);
    return record;
}

// ── Reasoning availability helper ───────────────────────────────────────────

/**
 * Determine reasoning availability from a raw event payload.
 *
 * @param {{ reasoningText?: string | null | undefined }} payload
 * @returns {{ availability: ReasoningAvailability[keyof ReasoningAvailability], text?: string }}
 */
export function classifyReasoning(payload) {
    if (!("reasoningText" in payload)) {
        return { availability: ReasoningAvailability.UNSUPPORTED };
    }
    const text = payload.reasoningText;
    if (text != null && text.length > 0) {
        return { availability: ReasoningAvailability.AVAILABLE, text };
    }
    return { availability: ReasoningAvailability.EMPTY };
}

// ── Parent attribution helper ───────────────────────────────────────────────

/**
 * Resolve the parent tool-call ID for an event, falling back to the
 * synthetic root when the SDK payload does not include one.
 *
 * @param {{ parentToolCallId?: string | null | undefined }} payload
 * @returns {string}
 */
export function resolveParent(payload) {
    return payload?.parentToolCallId || SYNTHETIC_ROOT_ID;
}

// ── Snapshot / query helpers ────────────────────────────────────────────────

/**
 * Build an index of tool-call IDs grouped by their parentToolCallId.
 *
 * @param {Map<string, ToolCallRecord>} toolCallMap
 * @returns {Map<string, string[]>}  parentToolCallId → [toolCallId, …]
 */
export function buildParentIndex(toolCallMap) {
    /** @type {Map<string, string[]>} */
    const index = new Map();
    for (const tc of toolCallMap.values()) {
        const key = tc.parentToolCallId;
        let list = index.get(key);
        if (!list) {
            list = [];
            index.set(key, list);
        }
        list.push(tc.id);
    }
    return index;
}

/**
 * Build a hierarchy-first execution-tree index for rendering a structural tree.
 *
 * Structural rules:
 *   - The synthetic root is always the single top-level root node.
 *   - Subagents are represented as structural nodes using their toolCallId.
 *   - Tool calls whose IDs also exist as subagents are hidden from the tree so
 *     the spawned subagent becomes the visible branch node.
 *   - Messages and non-hidden tool calls attach to their nearest structural
 *     parent using parentToolCallId. Broken parent references are attached to
 *     the root and marked orphaned.
 *
 * @param {Map<string, SubagentRecord>} subagents
 * @param {Map<string, ToolCallRecord>} toolCalls
 * @param {Map<string, AssistantMessageRecord>} messages
 * @returns {{
 *   rootNodeKey: string,
 *   nodeParentKeys: Record<string, string | null>,
 *   childNodeKeys: Record<string, string[]>,
 *   pathNodeKeys: Record<string, string[]>,
 *   descendantCounts: Record<string, number>,
 *   orphanNodeKeys: string[],
 *   hiddenToolCallIds: string[],
 * }}
 */
export function buildExecutionGraph(subagents, toolCalls, messages) {
    const rootNodeKey = makeExecutionNodeKey("root", SYNTHETIC_ROOT_ID);
    const nodeParentKeys = { [rootNodeKey]: null };
    const childNodeKeys = { [rootNodeKey]: [] };
    const hiddenToolCallIds = new Set(subagents.keys());
    const orphanNodeKeys = new Set();

    function ensureChildBucket(key) {
        if (!childNodeKeys[key]) {
            childNodeKeys[key] = [];
        }
        return childNodeKeys[key];
    }

    function structuralNodeKeyForToolCallId(toolCallId) {
        if (!toolCallId || toolCallId === SYNTHETIC_ROOT_ID) {
            return rootNodeKey;
        }
        if (subagents.has(toolCallId)) {
            return makeExecutionNodeKey("subagent", toolCallId);
        }
        if (toolCalls.has(toolCallId) && !hiddenToolCallIds.has(toolCallId)) {
            return makeExecutionNodeKey("toolcall", toolCallId);
        }
        return null;
    }

    function attachNode(kind, id, parentToolCallId) {
        const key = makeExecutionNodeKey(kind, id);
        let parentKey = structuralNodeKeyForToolCallId(parentToolCallId);
        if (!parentKey) {
            parentKey = rootNodeKey;
            if (parentToolCallId && parentToolCallId !== SYNTHETIC_ROOT_ID) {
                orphanNodeKeys.add(key);
            }
        }

        nodeParentKeys[key] = parentKey;
        ensureChildBucket(parentKey).push(key);
        ensureChildBucket(key);
    }

    for (const subagent of subagents.values()) {
        attachNode("subagent", subagent.id, toolCalls.get(subagent.id)?.parentToolCallId);
    }

    for (const toolCall of toolCalls.values()) {
        if (hiddenToolCallIds.has(toolCall.id)) continue;
        attachNode("toolcall", toolCall.id, toolCall.parentToolCallId);
    }

    for (const message of messages.values()) {
        attachNode("message", message.id, message.parentToolCallId);
    }

    for (const key of Object.keys(childNodeKeys)) {
        childNodeKeys[key].sort((a, b) => {
            const tsCompare = compareOriginTimestampDesc(
                getExecutionNodeOriginTimestamp(a, subagents, toolCalls, messages),
                getExecutionNodeOriginTimestamp(b, subagents, toolCalls, messages),
            );
            return tsCompare !== 0 ? tsCompare : a.localeCompare(b);
        });
    }

    // Pre-pass: detect parent-chain cycles and break them by reattaching the
    // first repeated node to the synthetic root. This keeps malformed data
    // visible (under root, flagged as orphan) instead of silently dropping
    // entire branches because a cycle never reaches the root in DFS.
    for (const startKey of Object.keys(nodeParentKeys)) {
        if (startKey === rootNodeKey) continue;
        const visited = new Set();
        let cur = startKey;
        while (cur && cur !== rootNodeKey) {
            if (visited.has(cur)) {
                const oldParent = nodeParentKeys[cur];
                if (oldParent && childNodeKeys[oldParent]) {
                    const siblings = childNodeKeys[oldParent];
                    const idx = siblings.indexOf(cur);
                    if (idx !== -1) siblings.splice(idx, 1);
                }
                nodeParentKeys[cur] = rootNodeKey;
                ensureChildBucket(rootNodeKey).push(cur);
                orphanNodeKeys.add(cur);
                break;
            }
            visited.add(cur);
            cur = nodeParentKeys[cur] ?? rootNodeKey;
        }
    }

    /** @type {Record<string, string[]>} */
    const pathNodeKeys = { [rootNodeKey]: [rootNodeKey] };

    // Iterative path computation. Walks parent chain into a list, then unrolls
    // it forward, caching the path for every node touched along the way.
    function pathFor(key) {
        if (pathNodeKeys[key]) return pathNodeKeys[key];
        const chain = [];
        let cur = key;
        while (cur !== rootNodeKey && !pathNodeKeys[cur]) {
            chain.push(cur);
            cur = nodeParentKeys[cur] ?? rootNodeKey;
        }
        let path = pathNodeKeys[cur] ?? [rootNodeKey];
        for (let i = chain.length - 1; i >= 0; i--) {
            path = [...path, chain[i]];
            pathNodeKeys[chain[i]] = path;
        }
        return pathNodeKeys[key] ?? path;
    }

    /** @type {Record<string, number>} */
    const descendantCounts = {};

    // Iterative post-order DFS from root so a deep tree (or accidentally
    // deep chain that survived cycle-breaking) cannot blow the JS call stack.
    {
        const stack = [rootNodeKey];
        const enteredChildren = new Set();
        const order = [];
        const seenInWalk = new Set();
        while (stack.length) {
            const k = stack[stack.length - 1];
            if (!enteredChildren.has(k)) {
                enteredChildren.add(k);
                const children = childNodeKeys[k] ?? [];
                for (const c of children) {
                    if (!seenInWalk.has(c)) {
                        seenInWalk.add(c);
                        stack.push(c);
                    }
                }
            } else {
                stack.pop();
                order.push(k);
            }
        }
        for (const k of order) {
            const children = childNodeKeys[k] ?? [];
            let total = 0;
            for (const c of children) {
                total += 1 + (descendantCounts[c] ?? 0);
            }
            descendantCounts[k] = total;
        }
    }

    for (const key of Object.keys(nodeParentKeys)) {
        pathFor(key);
        if (!(key in descendantCounts)) descendantCounts[key] = 0;
    }

    return {
        rootNodeKey,
        nodeParentKeys,
        childNodeKeys,
        pathNodeKeys,
        descendantCounts,
        orphanNodeKeys: [...orphanNodeKeys].sort(),
        hiddenToolCallIds: [...hiddenToolCallIds].sort(),
    };
}

/**
 * Return a sorted timeline of all records across types, ordered by their
 * originating timestamp (startedAt or timestamp).
 *
 * Each entry includes a discriminant `kind` so consumers can switch on type.
 *
 * @typedef {{ kind: "subagent", record: SubagentRecord }
 *         | { kind: "toolcall", record: ToolCallRecord }
 *         | { kind: "message",  record: AssistantMessageRecord }} TimelineEntry
 *
 * @param {Map<string, SubagentRecord>} subagents
 * @param {Map<string, ToolCallRecord>} toolCalls
 * @param {Map<string, AssistantMessageRecord>} messages
 * @returns {TimelineEntry[]}
 */
export function buildTimeline(subagents, toolCalls, messages) {
    /** @type {TimelineEntry[]} */
    const entries = [];

    for (const r of subagents.values()) {
        entries.push({ kind: "subagent", record: r });
    }
    for (const r of toolCalls.values()) {
        entries.push({ kind: "toolcall", record: r });
    }
    for (const r of messages.values()) {
        entries.push({ kind: "message", record: r });
    }

    entries.sort((a, b) => {
        const tsA = originTimestamp(a);
        const tsB = originTimestamp(b);
        return tsA < tsB ? -1 : tsA > tsB ? 1 : 0;
    });

    return entries;
}

/**
 * Extract the best "origin" timestamp from a timeline entry for ordering.
 * Uses explicit casts per branch to satisfy checkJs narrowing.
 * @param {TimelineEntry} entry
 * @returns {string}
 */
function originTimestamp(entry) {
    switch (entry.kind) {
        case "subagent": {
            /** @type {SubagentRecord} */ const r = entry.record;
            return r.startedAt ?? r._lastEventTs;
        }
        case "toolcall": {
            /** @type {ToolCallRecord} */ const r = entry.record;
            return r.startedAt ?? r._lastEventTs;
        }
        case "message": {
            /** @type {AssistantMessageRecord} */ const r = entry.record;
            return r.timestamp ?? r._lastEventTs;
        }
        default: return entry.record._lastEventTs ?? "";
    }
}

/**
 * @param {"root" | "subagent" | "toolcall" | "message"} kind
 * @param {string} id
 * @returns {string}
 */
function makeExecutionNodeKey(kind, id) {
    return `${kind}:${id}`;
}

/**
 * @param {string} key
 * @returns {{ kind: string, id: string }}
 */
function parseExecutionNodeKey(key) {
    const separator = key.indexOf(":");
    return separator === -1
        ? { kind: key, id: "" }
        : { kind: key.slice(0, separator), id: key.slice(separator + 1) };
}

/**
 * @param {string | undefined} a
 * @param {string | undefined} b
 * @returns {number}
 */
function compareOriginTimestampDesc(a, b) {
    const aTime = a ? Date.parse(a) : 0;
    const bTime = b ? Date.parse(b) : 0;
    return bTime - aTime;
}

/**
 * @param {string} key
 * @param {Map<string, SubagentRecord>} subagents
 * @param {Map<string, ToolCallRecord>} toolCalls
 * @param {Map<string, AssistantMessageRecord>} messages
 * @returns {string}
 */
function getExecutionNodeOriginTimestamp(key, subagents, toolCalls, messages) {
    const { kind, id } = parseExecutionNodeKey(key);
    switch (kind) {
        case "subagent": {
            const record = subagents.get(id);
            return record?.startedAt ?? record?._lastEventTs ?? "";
        }
        case "toolcall": {
            const record = toolCalls.get(id);
            return record?.startedAt ?? record?.completedAt ?? record?._lastEventTs ?? "";
        }
        case "message": {
            const record = messages.get(id);
            return record?.timestamp ?? record?._lastEventTs ?? "";
        }
        default:
            return "";
    }
}
