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
npm install

# UI (React + TypeScript)
cd content/
npm install
npm run watch    # Rebuild on changes
```

## Pull requests

1. Fork the repo and create a feature branch from `master`.
2. Keep changes focused — one concern per PR.
3. Test your changes against a live Copilot CLI session if possible.
4. Describe what your PR does and why in the PR description.

There is no CI pipeline yet. Manual testing against a live session is the current verification method.

## Code style

- Extension runtime: plain `.mjs` (ES modules), no transpilation
- UI: React + TypeScript, bundled with esbuild
- Commit messages: conventional-ish (`feat:`, `fix:`, `docs:`, `chore:`)

## Scope

This is a read-only observability tool. Changes that add write operations (modifying agent behavior) or persistent storage are out of scope for the alpha.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
