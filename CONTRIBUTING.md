# Contributing to Cells

Thanks for contributing. Cells is still early, so small, focused changes are much easier to review and ship than broad rewrites.

## Before You Start

- For large features, workflow changes, or architecture changes, open an issue first so the direction is clear before you invest time.
- Keep pull requests scoped. Separate refactors from behavior changes when practical.
- Update documentation when behavior, setup, or release expectations change.

## Development Environment

- Node.js 22 or newer
- pnpm 10 or newer
- macOS for the supported desktop workflow

Install dependencies:

```bash
pnpm install
```

If `node-pty` or other native dependencies fail to rebuild, install the Xcode Command Line Tools and retry.

Start the app in development mode:

```bash
pnpm dev
```

Useful checks:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
```

Optional local tools:

- `claude` and `codex` are detected automatically when available on `PATH`

## Release Notes and Versioning

This repository uses Changesets for release notes. If your change is user-facing, release-worthy, or changes how the app is packaged, add a changeset:

```bash
pnpm changeset
```

Internal-only changes that should not appear in release notes can usually skip this step.

## Pull Requests

Before opening a pull request:

- Rebase onto the current `main`
- Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm build`
- Add or update docs when needed
- Add a changeset when the change should be called out in a release

In the pull request description, include:

- What changed
- Why it changed
- How you tested it
- Screenshots or recordings for UI changes when helpful

## Code Style

- Follow the existing TypeScript, React, and Electron patterns already in the repo
- Prefer small, explicit components and state changes over broad abstractions
- Keep platform-specific behavior clearly marked, especially around Electron and macOS-only features
- Do not mix unrelated cleanup into a feature PR

## License

By submitting a contribution, you agree that your work will be licensed under the Apache License 2.0.
