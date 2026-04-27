# Media Plan — Copilot CLI Agent Observer Alpha

## Screenshot slots

All screenshots must be captured with the current `agent-observer` branding so
the window title, header, and any visible branding say "Agent Observer".
Use a sanitized demo workflow against a public-safe repo.

### 1. `hero-overview.png` → `docs/images/hero-overview.png`

**Purpose:** First thing visitors see in README — full-window dashboard.

**Composition:**
- Full observer window visible (title bar + stats cards + activity tree + detail pane)
- Stats cards populated with realistic counts (e.g., 2–4 subagents, 10+ tool calls)
- Activity tree expanded showing Root session → at least 2 subagents (e.g., Explore Agent, Task Agent)
- Detail pane showing **a selected tool call** with result content visible
- Dark theme (current default)

**Why new capture needed:** Existing `obs-verify2.png` shows tree but detail pane is empty
and uses old branding. Hero must show the full value at a glance.

### 2. `timeline-feed.png` → `docs/images/timeline-feed.png`

**Purpose:** Show the chronological activity feed with tool details.

**Composition:**
- "Recent activity" tab selected
- 6–10 visible timeline rows showing mix of tool types (glob, view, grep, edit, powershell)
- Tool badges (TOOL/MSG) and agent labels visible
- At least one row showing result snippet preview text
- Timestamps visible

**Reuse assessment:** `obs-timeline.png` has excellent composition for this slot.
Needs reshoot only for branding rename. Content (own-repo file paths like
`src/main.tsx`) is fine — it's the observer inspecting itself, which is a good demo story.

### 3. `detail-inspection.png` → `docs/images/detail-inspection.png`

**Purpose:** Show the inspection/drill-down UX — the "aha" moment of seeing what a
tool actually did.

**Composition:**
- Activity tree or timeline on left with one item highlighted/selected
- Detail pane on right populated with:
  - Tool name and type header
  - Agent attribution
  - Full tool arguments or result content
  - Timestamps and duration if available
- This is the screenshot that proves the "observability" promise

**Why new capture needed:** No existing screenshot shows the populated detail pane.
This is the most important missing asset.

## GIF / short video

### `demo-walkthrough.gif` → `docs/media/demo-walkthrough.gif`

**Purpose:** 10–20 second animated walkthrough showing the observer in action.

**Storyline:**
1. Observer window opens (0–2s) — empty/loading state briefly visible
2. Stats cards populate as events arrive (2–4s)
3. Activity tree shows agents appearing (4–8s)
4. User clicks to expand a subagent → tool calls appear (8–12s)
5. User clicks a specific tool call → detail pane fills with result (12–16s)
6. Brief pause on the detail view to let viewer read (16–20s)

**Format:** GIF preferred for GitHub README inline display. If file size > 10 MB,
provide MP4 in `docs/media/` and use a static hero screenshot in README with a
"▶ Watch demo" link.

**Capture tool options:**
- [LICEcap](https://www.cockos.com/licecap/) — lightweight GIF capture on Windows
- [ScreenToGif](https://www.screentogif.com/) — more control over frame editing
- OBS Studio → MP4 → ffmpeg to GIF (if higher quality needed)

## Sanitized demo requirements

All media must be captured from a workflow that:
- Uses a **public or purpose-built demo repo** (not private/work repos)
- Contains **no private file paths** (no `C:\Users\hhjo.FT\...` visible)
- Contains **no credentials, tokens, or API keys**
- Contains **no proprietary code or company-internal references**
- Shows **realistic but generic** agent activity (code search, file edits, test runs)

**Recommended demo approach:**
Use the observer repo itself as the demo target — "the observer observing its own
development." This is self-contained, public-safe, and tells a compelling meta-story.

## File inventory

| Slot | File | Location | Status |
|------|------|----------|--------|
| Hero screenshot | `hero-overview.png` | `docs/images/` | ✅ Captured (Playwright + mock data) |
| Timeline screenshot | `timeline-feed.png` | `docs/images/` | ✅ Captured (Playwright + mock data) |
| Detail screenshot | `detail-inspection.png` | `docs/images/` | ✅ Captured (Playwright + mock data) |
| Demo walkthrough | `demo-walkthrough.gif` | `docs/media/` | ✅ Captured (Playwright + mock data, assembled with ImageMagick) |

## Existing assets disposition

| File | Verdict | Reason |
|------|---------|--------|
| `obs-timeline.png` | **Deleted** | Replaced by `docs/images/timeline-feed.png` |
| `obs-verify.png` | **Deleted** | Not suitable for public use |
| `obs-verify2.png` | **Deleted** | Replaced by `docs/images/hero-overview.png` |

Root-level `obs-*.png` files should be deleted from repo root after final captures
are placed in `docs/images/`. They are development artifacts, not release assets.

## Capture dependency

All captures are **blocked on** the internal rename todo (`agent-observer`).
The rename changes window title, header text, and tool prefixes — all visible in
screenshots. Capturing before rename would produce assets that immediately need
replacing.

**Execution order:**
1. ✅ Media plan (this document)
2. ✅ Internal rename to `agent-observer`
3. ✅ Rebuild UI (`npm run build` in content/)
4. ✅ Run sanitized demo workflow (Playwright + mock data server)
5. ✅ Capture 3 screenshots
6. ✅ Capture 1 GIF (Playwright + mock data + ImageMagick assembly)
7. ✅ Place in `docs/images/` and `docs/media/`
8. ✅ Delete root `obs-*.png` files
9. ✅ Reference from README
