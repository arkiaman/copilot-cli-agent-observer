/**
 * Agent Observer — entry point (bootstrap only).
 *
 * All UI components, types, and model logic live in dedicated modules.
 * This file wires up the root React render and global error handlers.
 */

import { createRoot } from "react-dom/client";
import { renderFatal } from "./helpers.js";
import { FatalBoundary, App } from "./App.js";

window.addEventListener("error", (event) => {
    renderFatal(event.message || "Unhandled window error", event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
    renderFatal("Unhandled promise rejection", event.reason);
});

try {
    const rootEl = document.getElementById("root");
    if (!rootEl) {
        throw new Error("Missing #root element");
    }

    createRoot(rootEl).render(
        <FatalBoundary>
            <App />
        </FatalBoundary>,
    );
} catch (error) {
    renderFatal("Top-level boot failure", error);
}