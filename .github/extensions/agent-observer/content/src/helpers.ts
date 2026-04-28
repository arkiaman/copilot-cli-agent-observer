/**
 * Pure utility functions shared across the Agent Observer UI.
 * No React dependency — only operates on primitives and domain types.
 */

import type { StatusKey, NodeKind, Selection, ActivityItem } from "./types.js";

export function shortId(id: string): string {
    if (!id) return "—";
    if (id === "__root__") return "root";
    return id.length > 12 ? id.slice(0, 6) + "…" + id.slice(-4) : id;
}

export function fmtTime(iso?: string): string {
    if (!iso) return "—";
    try {
        const d = new Date(iso);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
        return iso;
    }
}

export function fmtDuration(ms?: number): string {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

export function statusIcon(status: string): string {
    switch (status) {
        case "started":
        case "running":
            return "⏳";
        case "completed":
        case "complete":
            return "✅";
        case "failed":
            return "❌";
        default:
            return "•";
    }
}

export function statusClass(status: string): string {
    switch (status) {
        case "started":
        case "running":
            return "status-running";
        case "completed":
        case "complete":
            return "status-complete";
        case "failed":
            return "status-failed";
        default:
            return "";
    }
}

export function normalizeStatus(status: string): StatusKey {
    if (status === "started" || status === "running") return "running";
    if (status === "failed") return "failed";
    return "complete";
}

export function safeText(value: unknown): string {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim();
}

export function previewText(value: string, limit: number): string {
    if (!value) return "(empty)";
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export function shortPath(p: string): string {
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length <= 2) return p;
    return parts.slice(-2).join("/");
}

export function tryParseJSON(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return null; }
}

export function summarizeArgs(toolName: string, args: unknown): string {
    const parsed = tryParseJSON(args) ?? args;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const obj = parsed as Record<string, unknown>;
    const byTool: Record<string, { keys: string[]; transform?: (v: string, o: Record<string, unknown>) => string }> = {
        grep:       { keys: ["pattern", "query"] },
        view:       { keys: ["path", "file"], transform: (v, o) => {
            const base = shortPath(v);
            const range = o["view_range"];
            if (Array.isArray(range) && range.length === 2) return `${base}:${range[0]}–${range[1]}`;
            return base;
        }},
        glob:       { keys: ["pattern", "path"], transform: (v) => shortPath(v) },
        powershell: { keys: ["command", "script"] },
        bash:       { keys: ["command", "script"] },
    };
    const spec = byTool[toolName.toLowerCase()];
    const keys = spec?.keys ?? [];
    for (const k of keys) {
        if (typeof obj[k] === "string" && obj[k]) {
            const raw = safeText(obj[k] as string);
            const display = spec?.transform ? spec.transform(raw, obj) : raw;
            return previewText(display, 100);
        }
    }
    for (const v of Object.values(obj)) {
        if (typeof v === "string" && v.trim()) return previewText(safeText(v), 100);
    }
    return "";
}

export function resultSnippet(toolName: string, resultPreview: string | undefined): string {
    if (!resultPreview) return "";
    const text = safeText(resultPreview);
    if (!text) return "";
    const lines = text.split("\n");
    const meaningful = lines.find((l) => {
        const t = l.trim();
        return t && !/^[-=]+$/.test(t) && !/^\d+ match/.test(t) && !/^No matches/.test(t);
    }) ?? lines.find((l) => l.trim()) ?? text;
    return previewText(meaningful, 120);
}

export function compareIsoDesc(a?: string, b?: string): number {
    const aTime = a ? Date.parse(a) : 0;
    const bTime = b ? Date.parse(b) : 0;
    return bTime - aTime;
}

export function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

export function selectionKey(selection: Selection): string | null {
    return selection ? `${selection.kind}:${selection.id}` : null;
}

export function itemSelectionKey(item: ActivityItem): string {
    return `${item.kind}:${item.id}`;
}

export function makeNodeKey(kind: NodeKind, id: string): string {
    return `${kind}:${id}`;
}

export function parseNodeKey(key: string): { kind: NodeKind; id: string } {
    const index = key.indexOf(":");
    return {
        kind: (index === -1 ? key : key.slice(0, index)) as NodeKind,
        id: index === -1 ? "" : key.slice(index + 1),
    };
}

export function renderFatal(message: string, detail?: unknown) {
    const root = document.getElementById("root");
    if (!root) return;

    const detailText =
        detail instanceof Error ? (detail.stack || detail.message) :
        typeof detail === "string" ? detail :
        detail != null ? JSON.stringify(detail, null, 2) :
        "";

    root.innerHTML = `
      <div class="fatal-screen">
        <div class="fatal-box">
          <div class="fatal-title">Agent Observer failed to render</div>
          <div class="fatal-text">${escapeHtml(message)}</div>
          ${detailText ? `<pre class="fatal-pre">${escapeHtml(detailText)}</pre>` : ""}
        </div>
      </div>
    `;
}

export function stringifyForSearch(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function pluralize(count: number, noun: string, plural = `${noun}s`): string {
    return `${count} ${count === 1 ? noun : plural}`;
}

export function titleCase(value: string): string {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function extractNamedText(value: unknown, keys: string[], depth = 0): string | null {
    if (depth > 4 || value == null) return null;
    if (typeof value === "string") {
        const text = value.trim();
        return text ? text : null;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = extractNamedText(item, keys, depth + 1);
            if (found) return found;
        }
        return null;
    }
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        for (const key of keys) {
            if (key in record) {
                const found = extractNamedText(record[key], keys, depth + 1);
                if (found) return found;
            }
        }
    }
    return null;
}

export function toPromptBlock(value: string, maxLines = 10): string {
    const lines = value.split(/\r?\n/);
    const shown = lines.slice(0, maxLines).join("\n");
    return lines.length > maxLines ? `${shown}\n…` : shown;
}
