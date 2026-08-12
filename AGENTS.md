# Pinnables Agent Notes

## Stack
- TypeScript / React extension + packages monorepo under `packages/`.
- Prefer package-local changes; do not invent cross-package APIs without need.

## Tests
- Extension tests often run via `tsx --test` with the package tsconfig (see existing scripts under `packages/extension`).
- Run the narrowest relevant test first; full suite only when integrating.

## Product honesty
- Do not invent metrics, user counts, or launch claims.
- Prefer existing MCP / tooling when available (`pinnables` MCP in Cursor).

## Agent workflow
- Use root skills for process (TDD/debug/verify/plans/worktrees).
- Web UI taste comes from Cursor EDT skills; this is not a SwiftUI project.
