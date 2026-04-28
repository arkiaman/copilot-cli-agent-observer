# Contributing

Thanks for your interest in Copilot CLI Agent Observer! This project is in **early alpha** — contributions, bug reports, and feedback are welcome.

## Reporting issues

Open a [GitHub issue](../../issues) with:

- What you expected vs. what happened
- Your platform (OS, Node version, Copilot CLI version)
- Steps to reproduce, if possible

## Development setup

See the [Build & development](README.md#build--development) section of the README for environment setup.

Quick start:

```bash
# Extension runtime
cd .github/extensions/agent-observer/
npm ci

# UI (React + TypeScript)
cd content/
npm ci
npm run watch    # Rebuild on changes
```

To test a local checkout as a real Copilot CLI extension:

1. Copy `.github/extensions/agent-observer` into `~/.copilot/extensions/agent-observer`
2. If a Copilot session is already open with experimental/extensions enabled, ask Copilot to reload extensions (`extensions_reload`). Otherwise start a clean session with `copilot --experimental`
3. Run `/env` and confirm `agent-observer` appears under **Extensions**
4. Run `/agent-observer`

Do not use `copilot plugin install ...` or `copilot plugin marketplace add ...` against this repo. Those paths are intentionally unsupported until Copilot CLI can ship bundled extensions through plugin packaging.

For user-facing install docs, prefer `install.ps1` / `install.sh`. They install the extension by copying `.github/extensions/agent-observer` into the user's Copilot extensions directory.

If you change local extension files, copy the updated folder if needed, then either ask Copilot to reload extensions in an existing experimental/extensions-enabled session or restart with `copilot --experimental`.

## Pull requests

1. Fork the repo and create a feature branch from `master`.
2. Keep changes focused — one concern per PR.
3. Test your changes against a live Copilot CLI session if possible.
4. Describe what your PR does and why in the PR description.

CI runs automatically on push / PR to `master` (see `.github/workflows/ci.yml`). It checks:

- Extension and UI dependency install
- UI esbuild bundle
- Unit tests for the event model and store

You can run the tests locally:

```bash
cd .github/extensions/agent-observer/
npm test
```

Manual testing against a live Copilot CLI session is still recommended for UI and end-to-end changes.

If you need the debug-only `agent_observer_eval` tool locally, set `AGENT_OBSERVER_DEV=1` before starting Copilot CLI. That same flag also enables Agent Observer startup diagnostic logs.

## Code style

- Extension runtime: plain `.mjs` (ES modules), no transpilation
- UI: React + TypeScript, bundled with esbuild
- Commit messages: conventional-ish (`feat:`, `fix:`, `docs:`, `chore:`)

## Scope

This is a read-only observability tool. Changes that add write operations (modifying agent behavior) or persistent storage are out of scope for the alpha.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
