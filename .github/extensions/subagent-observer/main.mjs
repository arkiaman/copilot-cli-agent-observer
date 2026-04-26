/**
 * subagent-observer — main extension entry
 *
 * Combines:
 *   1. Webview shell (copilot-webview pattern) for future subagent visualization UI.
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

import { joinSession } from "@github/copilot-sdk/extension";
import { join } from "node:path";
import { CopilotWebview } from "./lib/copilot-webview.js";
import { createEventStore, wireSession } from "./lib/event-store.js";

// ── Normalized event store ──────────────────────────────────────────────────

const store = createEventStore();

// ── Session-lifecycle state ─────────────────────────────────────────────────

/** Cleanup function returned by the most recent wireSession() call. */
let unwirePrevious = null;
/** Monotonic counter incremented on each session transition.  wireSession
 *  compares its captured value to detect stale in-flight startups. */
let sessionGeneration = 0;

// ── Webview setup ───────────────────────────────────────────────────────────

const webview = new CopilotWebview({
    extensionName: "subagent_observer",
    contentDir: join(import.meta.dirname, "content"),
    title: "Subagent Observer",
    width: 1100,
    height: 750,
    callbacks: {
        log: (msg, opts) => session.log(msg, opts),

        // Expose normalized snapshot data to the webview for rendering
        getSnapshot: () => JSON.stringify(store.snapshot()),
    },
});

// ── Observer dump tool (normalized) ─────────────────────────────────────────

const observerDumpTool = {
    name: "observer_dump_summary",
    description: [
        "Returns a structured summary of all subagent and tool events captured by the",
        "subagent-observer extension since it was loaded. Use this after triggering a",
        "subagent run to verify that parent-session observability works.",
    ].join(" "),
    parameters: { type: "object", properties: {} },
    skipPermission: true,
    handler: async () => JSON.stringify(store.dumpSummary(), null, 2),
};

// ── Join session ────────────────────────────────────────────────────────────

const session = await joinSession({
    hooks: {
        onSessionStart: async () => {
            // Tear down previous wiring (if any) so listeners aren't duplicated
            // across session transitions within the same extension load.
            if (unwirePrevious) {
                try { unwirePrevious(); } catch { /* best-effort */ }
                unwirePrevious = null;
            }
            // Reset store so stale data from a prior session is not carried over.
            store.reset();
            // Bump generation so any in-flight wireSession from a prior start
            // will detect it is stale and bail out.
            const gen = ++sessionGeneration;

            // Buffered startup: subscribe → replay → merge → live
            const unwire = await wireSession(store, session, {
                log: (msg) => session.log(msg),
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
        },
        onSessionEnd: async () => {
            // Tear down live listeners first, then close webview.
            if (unwirePrevious) {
                try { unwirePrevious(); } catch { /* best-effort */ }
                unwirePrevious = null;
            }
            webview.close();
            await session.log("subagent-observer: session ended, webview closed").catch(() => {});
        },
    },
    tools: [
        ...webview.tools,
        observerDumpTool,
    ],
    commands: [{
        name: "subagent-observer",
        description: "Open the subagent observer webview window.",
        handler: webview.show,
    }],
});
