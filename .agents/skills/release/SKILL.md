---
name: release
description: Create a new release version. Bumps package.json, commits, tags, pushes, and triggers the GitHub Actions release workflow via workflow_dispatch. Ensures CI passes before releasing.
---

# Release

Use this skill when the user asks to make a release, cut a version, or ship a new build.

## Steps

1. **Ensure working tree is clean** — all changes must be committed before releasing. If there are uncommitted changes, commit them first (with user approval).

2. **Push to remote and wait for CI to pass** — push the current branch and check that the CI workflow succeeds before proceeding. Use `gh run watch` or poll `gh run list` to confirm the latest CI run on the pushed commit passes. Do NOT proceed to tagging if CI is failing.

3. **Determine the next version** — read the current version from `package.json`. The last release tag can be found via `git tag -l 'v*' --sort=-v:refname | head -1`. Bump the patch version by default unless the user specifies a different bump (minor, major).

4. **Bump version** — update `"version"` in `package.json` to the new version.

5. **Commit and tag** — commit as `release: vX.Y.Z` and create tag `vX.Y.Z`.

6. **Push commit and tag** — `git push && git push origin vX.Y.Z`.

7. **Trigger the release workflow** — run `gh workflow run release.yml -f tag=vX.Y.Z`. The release workflow is `workflow_dispatch` only — it does NOT run automatically on tag push. It builds, signs, and publishes the release via electron-builder.

## Critical Rules

- **NEVER** run `gh release create` — electron-builder creates a draft release and the workflow converts it. Creating one manually causes a type conflict and skips asset upload.
- **NEVER** build locally with `electron-builder` — node-pty requires native rebuild that only CI has configured.
- **ALWAYS** use `pnpm`, never `npm`.
- **ALWAYS** wait for CI to be green before tagging. If CI fails, fix the issue first.
- **ALWAYS** trigger the release workflow manually via `gh workflow run` after pushing the tag.
- Feature commits should use descriptive messages (`feat:`, `fix:`, etc.) — the changelog filters out `release:` and `Merge` prefixes.
