# Supply Vanguard

Equipment and supply tracking with an explorable NICU concept. This repository contains the complete editable Three.js scene, 25 reusable equipment GLBs, two preserved original ward GLBs, a working browser demo, implementation plan, and shared agent claiming board.

## Start

Requires Node.js 22+, Git, and GitHub CLI for shared task operations.

```sh
npm run dev
# Open http://localhost:4180
npm run setup:test   # once per clean checkout: installs PGlite, the test-only embedded database
npm test
npm run check
```

The demo itself needs no install. Only `npm test` needs `npm run setup:test` first; without it the run stops with a message saying so instead of a stack trace. PostgreSQL 16+ is optional: the native database tests are skipped, and say so, when it is not installed.

Select equipment, change its room/status, and locate it in the 3D ward. Changes and recent history persist in this browser. Orbit, walk, inspect equipment models, and explore supply locations in the embedded viewer. No hosted services or API keys are needed for this demo.

## Coordinate work

[Live claiming board](https://github.com/wiltobuild/supply-vanguard/tree/task-board) · [Implementation plan](planning/IMPLEMENTATION_PLAN.md) · [Agent instructions](AGENTS.md)

```sh
gh auth login
npm run board -- list
npm run board -- next --owner YOUR_NAME --agent YOUR_NAME-claude-1
```

Only start after a successful claim. Use separate clones/worktrees for simultaneous agents. The private repository requires collaborator write access for your partner. Local seed files are not the shared board; the CLI synchronizes the remote `task-board` branch with conflict-checked pushes.

## Layout

The [shared UI/UX direction](design/README.md) contains the user-selected homepage reference and requirements for all future app screens.

- `apps/web`: equipment register and scene integration.
- `packages/domain`: versioned equipment updates, sample records and audit events.
- `packages/scene/viewer`: full existing 3D source, vendored Three.js and GLB files under `assets/`.
- `planning`: full roadmap and initial task definitions.
- `tools`: local server, validation, shared task board CLI.
- `tests`: domain and concurrent claiming checks.

The Baltimore Children's Center concept includes six infant rooms and support areas. Layout dimensions, equipment makes and placement are illustrative, not an authenticated Hopkins floor plan. Original reference notes and public sources are preserved in [scene documentation](packages/scene/REFERENCE.md) and the viewer Sources dialog. The demo uses synthetic inventory, manual location updates, and browser storage; authentication, shared database, live tracking and production operations are planned work. The prior Supply Sentry viewer is preserved inside the Supply Vanguard scaffold.

The [fifteen additional NICU models](packages/scene/ADDITIONAL_ASSETS.md) are illustrative static decoration in the live ward, separate from tracked equipment. Open `/ward/additional-gallery.html` for the collection contact sheet, or use the ward's 3D asset library to inspect and download any of the 25 equipment models. The two original ward GLBs remain unchanged baseline snapshots.
