/**
 * Subagent Observer — React content entry point (shell)
 *
 * This is the minimal React shell. The visualization UI will be built here
 * in a later todo. For now it renders a placeholder and proves the
 * copilot bridge + React rendering pipeline works end-to-end.
 */

import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";

declare const copilot: {
    log: (msg: string, opts?: unknown) => Promise<void>;
    getSnapshot: () => Promise<string>;
};

interface Snapshot {
    subagents: unknown[];
    toolCalls: unknown[];
    recentEvents: { ts: string; type: string; summary: string }[];
}

function App() {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function refresh() {
        try {
            const raw = await copilot.getSnapshot();
            setSnapshot(JSON.parse(raw));
            setError(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    useEffect(() => {
        refresh();
        const id = setInterval(refresh, 3000);
        return () => clearInterval(id);
    }, []);

    return (
        <>
            <header>
                <h1>🔭 Subagent Observer</h1>
                {snapshot && (
                    <>
                        <span className="badge">
                            {snapshot.subagents.length} subagent{snapshot.subagents.length !== 1 ? "s" : ""}
                        </span>
                        <span className="badge">
                            {snapshot.toolCalls.length} tool call{snapshot.toolCalls.length !== 1 ? "s" : ""}
                        </span>
                        <span className="badge">
                            {snapshot.recentEvents.length} event{snapshot.recentEvents.length !== 1 ? "s" : ""}
                        </span>
                    </>
                )}
            </header>
            <main>
                {error && <div className="placeholder">⚠️ {error}</div>}
                {!error && !snapshot && <div className="placeholder">Loading…</div>}
                {!error && snapshot && snapshot.recentEvents.length === 0 && (
                    <div className="placeholder">
                        No events captured yet.<br />
                        Trigger a subagent run to see activity here.
                    </div>
                )}
                {!error && snapshot && snapshot.recentEvents.length > 0 && (
                    <div className="placeholder">
                        Visualization coming soon.<br />
                        {snapshot.recentEvents.length} events captured — use <code>observer_dump_summary</code> tool for details.
                    </div>
                )}
            </main>
        </>
    );
}

createRoot(document.getElementById("root")!).render(<App />);
