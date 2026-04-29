# Demo Walkthrough — Deferred

The animated GIF walkthrough (`demo-walkthrough.gif`) requires a screen-recording
tool (LICEcap, ScreenToGif, or OBS + ffmpeg) to capture the native webview window
in real time. This cannot be automated via Playwright since the observer runs as a
native OS window, not a browser tab.

## How to capture manually

1. Open a Copilot CLI session with the Agent Observer extension loaded.
2. Start a multi-agent task (e.g., ask Copilot to analyze a repo).
3. Ask the agent to "open the agent observer" (uses the `agent_observer_show` tool).
4. Start your screen recorder on the observer window.
5. Record 15–20 seconds showing:
   - Stats cards populating
   - Execution tree expanding
   - Clicking a subagent to reveal tool calls
   - Clicking a tool call to show the detail pane
6. Save as GIF (< 10 MB) to `docs/media/demo-walkthrough.gif`.

If the GIF exceeds 10 MB, save as MP4 instead and use a static screenshot
in the README with a "▶ Watch demo" link.
