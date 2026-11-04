# Supply Vanguard

Equipment and supply tracking with an explorable NICU concept. This repository contains the complete editable Three.js scene, 12 reusable GLB assets, a working browser demo, implementation plan, and shared agent claiming board.

## Start

Requires Node.js 22+, Git, and GitHub CLI for shared task operations.

```sh
npm run dev
# Open http://localhost:4180
npm test
npm run check
```

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

- `apps/web`: equipment register and scene integration.
- `packages/domain`: versioned equipment updates, sample records and audit events.
- `packages/scene/viewer`: full existing 3D source, vendored Three.js and GLB files under `assets/`.
- `planning`: full roadmap and initial task definitions.
- `tools`: local server, validation, shared task board CLI.
- `tests`: domain and concurrent claiming checks.

The Baltimore Children's Center concept includes six infant rooms and support areas. Layout dimensions, equipment makes and placement are illustrative, not an authenticated Hopkins floor plan. Original reference notes and public sources are preserved in [scene documentation](packages/scene/REFERENCE.md) and the viewer Sources dialog. The demo uses synthetic inventory, manual location updates, and browser storage; authentication, shared database, live tracking and production operations are planned work. The prior Supply Sentry viewer is preserved inside the Supply Vanguard scaffold.
