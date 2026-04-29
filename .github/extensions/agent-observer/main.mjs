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
 *   3. Tools and commands expose normalized snapshot data.
 *
 * The webview content is a React + TypeScript app under content/, built with esbuild.
 * It is NOT auto-built — run `npm run build` inside content/ after editing TSX.
 */

export const VERSION = "1.2.0";

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

// ── Diagnostics state (populated after joinSession) ─────────────────────────
const _diag = {
    version: VERSION,
    hasCommandHandlers: false,
    commandHandlersType: "unknown",
    hasExecuteCommand: false,
    mapGetPatched: false,
    dispatchPatched: false,
    mapGetCalls: [],      // last N calls to patched .get()
    dispatchCalls: [],    // last N calls to patched _executeCommandAndRespond
    patchError: null,
    mapContentsAtPatch: [],
    sessionKeys: [],
};

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
    handler: async () => {
        // Live checks at dump time (detect replacement after patch)
        const live = {};
        try {
            live.mapIsOriginal = session.commandHandlers === _diag._patchedMap;
            live.getIsPatched = session.commandHandlers?.get === _diag._patchedGet;
            live.dispatchIsPatched = session._executeCommandAndRespond === _diag._patchedDispatch;
            live.currentMapKeys = session.commandHandlers instanceof Map ? [...session.commandHandlers.keys()] : [];
        } catch {}
        return JSON.stringify({
            version: VERSION,
            diagnostics: { ..._diag, _patchedMap: undefined, _patchedGet: undefined, _patchedDispatch: undefined },
            live,
            ...store.dumpSummary(),
        }, null, 2);
    },
};

// ── Slash commands ───────────────────────────────────────────────────────────

const openObserverHandler = async () => { await webview.show(); };

const COMMANDS = [
    { name: "agent-observer", description: "Open the agent observer webview window.", handler: openObserverHandler },
    { name: "observer",       description: "Open the agent observer webview window.", handler: openObserverHandler },
];

// ── Join session ────────────────────────────────────────────────────────────

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
    commands: COMMANDS,
});

// ── Command dispatcher fallback + diagnostics ──────────────────────────────
// Populate _diag (declared above, before observer_dump_summary tool).
const OBSERVER_COMMAND_NAMES = new Set(COMMANDS.map(c => c.name));
const OBSERVER_HANDLERS = new Map(COMMANDS.map(c => [c.name, c.handler]));

/** Normalize a command name — strip leading "/" if present, trim whitespace. */
function normalizeCmd(name) {
    if (typeof name !== "string") return name;
    const trimmed = name.trim();
    return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

try {
    const cmdMap = session.commandHandlers;
    _diag.commandHandlersType = cmdMap === undefined ? "undefined"
        : cmdMap === null ? "null"
        : cmdMap instanceof Map ? "Map"
        : typeof cmdMap;
    _diag.hasCommandHandlers = cmdMap instanceof Map;
    _diag.hasExecuteCommand = typeof session._executeCommandAndRespond === "function";

    // Record what keys exist on the session object (for debugging)
    try { _diag.sessionKeys = Object.getOwnPropertyNames(session).slice(0, 30); } catch {}

    if (cmdMap instanceof Map) {
        // Record initial map contents
        try { _diag.mapContentsAtPatch = [...cmdMap.keys()]; } catch {}

        // PRIMARY FIX: Patch the Map's .get() method directly
        const nativeGet = Map.prototype.get;
        const patchedGet = function (key) {
            // Ring buffer: keep last 20 calls (shift oldest when full)
            _diag.mapGetCalls.push({ key, ts: Date.now() });
            if (_diag.mapGetCalls.length > 20) _diag.mapGetCalls.shift();
            // Check both raw and normalized (handles "/observer" → "observer")
            const norm = normalizeCmd(key);
            if (OBSERVER_COMMAND_NAMES.has(key) || OBSERVER_COMMAND_NAMES.has(norm)) {
                return OBSERVER_HANDLERS.get(norm);
            }
            // For non-observer keys, preserve native Map#get semantics exactly
            return nativeGet.call(this, key);
        };
        cmdMap.get = patchedGet;
        _diag.mapGetPatched = true;
        _diag._patchedMap = cmdMap;
        _diag._patchedGet = patchedGet;
    }

    // SECONDARY: Also patch _executeCommandAndRespond
    if (typeof session._executeCommandAndRespond === "function") {
        const originalDispatch = session._executeCommandAndRespond.bind(session);
        const patchedDispatch = async function (requestId, commandName, command, args) {
            const norm = normalizeCmd(commandName);
            // Record call for diagnostics
            _diag.dispatchCalls.push({ commandName, norm, requestId, ts: Date.now() });
            if (_diag.dispatchCalls.length > 20) _diag.dispatchCalls.shift();
            if ((OBSERVER_COMMAND_NAMES.has(commandName) || OBSERVER_COMMAND_NAMES.has(norm))
                && this?.commandHandlers instanceof Map) {
                this.commandHandlers.set(commandName, OBSERVER_HANDLERS.get(norm));
                if (commandName !== norm) {
                    this.commandHandlers.set(norm, OBSERVER_HANDLERS.get(norm));
                }
            }
            return originalDispatch(requestId, commandName, command, args);
        };
        session._executeCommandAndRespond = patchedDispatch;
        _diag.dispatchPatched = true;
        _diag._patchedDispatch = patchedDispatch;
    }
} catch (e) {
    _diag.patchError = e?.message ?? String(e);
}

// Always log version to stderr for debugging
console.error(`agent-observer v${VERSION} | cmdMap=${_diag.commandHandlersType} | mapPatch=${_diag.mapGetPatched} | dispPatch=${_diag.dispatchPatched}`);

// Attach immediately to the current foreground session as soon as the extension
// loads. `onSessionStart` covers later transitions, but existing sessions need an
// eager initial wire-up.
await startObserving();
