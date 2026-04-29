/**
 * agent-observer — main extension entry
 *
 * Combines:
 *   1. Webview shell (copilot-webview pattern) for agent visualization UI.
 *   2. Normalized event store fed by a buffered startup merge strategy:
 *      - Live listeners registered first (events buffered).
 *      - Replay via session.getMessages() populates the store.
 *      - Buffered live events merged (upsert handles dedupe).
 *      - Store switches to direct live ingestion.
 *   3. Tools expose normalized snapshot data.
 *
 * The webview content is a React + TypeScript app under content/, built with esbuild.
 * It is NOT auto-built — run `npm run build` inside content/ after editing TSX.
 */

import { joinSession } from "@github/copilot-sdk/extension";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { CopilotWebview } from "./lib/copilot-webview.js";
import { createEventStore, wireSession } from "./lib/event-store.js";

// ── Session identity ────────────────────────────────────────────────────────
// Derived synchronously before CopilotWebview is constructed (native window
// title is frozen at spawn time — no post-creation update channel exists).

function deriveSessionMeta() {
    const cwdPath = process.cwd();
    const cwdName = basename(cwdPath);
    let branch = null;
    try {
        branch = execSync("git rev-parse --abbrev-ref HEAD", {
            cwd: cwdPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim() || null;
    } catch { /* not a git repo or git unavailable — fine */ }

    const label = branch ? `${cwdName} @ ${branch} (${process.pid})` : `${cwdName} (${process.pid})`;
    return {
        label,
        cwdName,
        cwdPath,
        branch,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        // workspacePath is set later from session object (post-joinSession)
        workspacePath: null,
    };
}

const sessionMeta = deriveSessionMeta();

// ── Normalized event store ──────────────────────────────────────────────────

const store = createEventStore();
const isDevMode = process.env.AGENT_OBSERVER_DEV === "1";

// ── Session-lifecycle state ─────────────────────────────────────────────────

/** Cleanup function returned by the most recent wireSession() call. */
let unwirePrevious = null;
/** Monotonic counter incremented on each session transition.  wireSession
 *  compares its captured value to detect stale in-flight startups. */
let sessionGeneration = 0;

async function startObserving() {
    // Tear down previous wiring (if any) so listeners aren't duplicated
    // across session transitions within the same extension load.
    if (unwirePrevious) {
        try { unwirePrevious(); } catch { /* best-effort */ }
        unwirePrevious = null;
    }
    // Reset store so stale data from a prior session is not carried over.
    store.reset();
    // Invalidate enriched snapshot cache on session transition.
    _cachedStoreJson = null;
    _cachedEnrichedJson = null;
    // Pick up workspace path from the session object (available post-joinSession).
    // Always reset to avoid leaking a stale path from a prior session.
    sessionMeta.workspacePath = session?.workspacePath ?? null;
    // Bump generation so any in-flight wireSession from a prior start
    // will detect it is stale and bail out.
    const gen = ++sessionGeneration;

    const unwire = await wireSession(store, session, {
        log: (msg) => session.log(msg),
        enableDiagnosticLogs: isDevMode,
        generation: gen,
        isCurrentGeneration: () => sessionGeneration === gen,
    });

    // Only install the cleanup handle if we are still the current generation.
    if (sessionGeneration === gen) {
        unwirePrevious = unwire;
    } else {
        // A newer session transition already happened — clean up immediately.
        try { unwire(); } catch { /* best-effort */ }
    }
}

// ── Webview setup ───────────────────────────────────────────────────────────

// Snapshot enrichment cache — avoids re-parse/re-stringify on every 3s poll
// when only sessionMeta changed (it rarely does).
let _cachedStoreJson = null;
let _cachedEnrichedJson = null;

function enrichedSnapshotJson() {
    const storeJson = store.snapshotJson();
    if (storeJson === _cachedStoreJson && _cachedEnrichedJson) return _cachedEnrichedJson;
    const snap = JSON.parse(storeJson);
    snap.sessionMeta = { ...sessionMeta };
    _cachedEnrichedJson = JSON.stringify(snap);
    _cachedStoreJson = storeJson;
    return _cachedEnrichedJson;
}

const webview = new CopilotWebview({
    extensionName: "agent_observer",
    contentDir: join(import.meta.dirname, "content"),
    title: `Agent Observer — ${sessionMeta.label}`,
    width: 1100,
    height: 750,
    enableEvalTool: isDevMode,
    callbacks: {
        log: (msg, opts) => session.log(msg, opts),

        // Expose normalized snapshot data + session identity to the webview
        getSnapshot: () => enrichedSnapshotJson(),
    },
});

// ── Observer dump tool (normalized) ─────────────────────────────────────────

const observerDumpTool = {
    name: "observer_dump_summary",
    description: [
        "Returns a structured summary of all subagent and tool events captured by the",
        "agent-observer extension since it was loaded. Use this after triggering a",
        "subagent run to verify that parent-session observability works.",
    ].join(" "),
    parameters: { type: "object", properties: {} },
    skipPermission: true,
    handler: async () => JSON.stringify(store.dumpSummary(), null, 2),
};

// ── Join session ────────────────────────────────────────────────────────────
// NOTE: Slash commands (/observer, /agent-observer) were removed because the
// SDK feature they depend on (registerCommands) is absent in the universal
// SDK bundle that many CLI builds resolve at runtime. The mismatch causes a
// confusing "Unknown command" error even though the window opens via the
// agent_observer_show tool. Tools work across all SDK versions, so the
// recommended UX is: ask the agent "open the observer" or use the tool
// directly.

const session = await joinSession({
    hooks: {
        onSessionStart: startObserving,
        onSessionEnd: async () => {
            // Tear down live listeners first, then close webview.
            if (unwirePrevious) {
                try { unwirePrevious(); } catch { /* best-effort */ }
                unwirePrevious = null;
            }
            webview.close();
            await session.log("agent-observer: session ended, webview closed").catch(() => {});
        },
    },
    tools: [
        ...webview.tools,
        observerDumpTool,
    ],
});

// Attach immediately to the current foreground session as soon as the extension
// loads. `onSessionStart` covers later transitions, but existing sessions need an
// eager initial wire-up.
await startObserving();
