# Working together

Read README.md and planning/IMPLEMENTATION_PLAN.md. Use the shared board before editing. Requires GitHub write access, authenticated Git and `gh`. Never use force pushes on `task-board`; never treat planning/tasks.json as live claims.

## Claim a task

```sh
npm run board -- list
npm run board -- next --owner YOUR_NAME --agent YOUR_NAME-AGENT-UNIQUE_ID
# Or claim a specific ready task:
npm run board -- claim SV-001 --owner YOUR_NAME --agent YOUR_NAME-AGENT-UNIQUE_ID
```

Wait for exit code 0 and the confirmed claim before starting. A competing claim fails or `next` selects another ready task. Work in your own clone/worktree and branch, following the returned branch suggestion. One task per agent. Scope work to the task's files and acceptance criteria. Coordinate shared-file changes through PR review.

Claims expire after 120 minutes. Renew every 30 minutes and before substantial edits or commits:

```sh
npm run board -- heartbeat SV-001 --agent YOUR_AGENT_ID
```

If renewal fails, stop edits and re-read the board. Expired work may have been reclaimed. Local ignored `.claims/` files hold the lease identifier; keep the same checkout for renewal. If lost, wait for expiry and reclaim rather than impersonating another claim. Agent/owner names are coordination labels, not authenticated identities; repository access controls govern writes. This system assumes cooperative collaborators, not hostile agents.

## Finish, release or block

Run `npm test` and `npm run check`, plus task-specific verification. Commit the implementation, push a work branch, and create a PR including task ID, acceptance evidence, and remaining limitations.

```sh
npm run board -- submit SV-001 --agent YOUR_AGENT_ID --pr https://github.com/wiltobuild/supply-vanguard/pull/1
npm run board -- release SV-001 --agent YOUR_AGENT_ID
npm run board -- block SV-001 --agent YOUR_AGENT_ID --reason "Explain the dependency"
```

Submission clears the lease and holds the task in review. A different reviewer agent reviews the PR and after it is merged runs:

```sh
npm run board -- complete SV-001 --agent REVIEWER_ID
# Return review work or resolve a blocker:
npm run board -- rework SV-001 --agent REVIEWER_ID --reason "Specific required changes"
npm run board -- unblock SV-001 --agent REVIEWER_ID --reason "Blocker resolved"
```

The CLI verifies a merged PR in this repo before completion. Do not mark tasks complete based on intent. Preserve provenance and synthetic-data labels; never claim exact architectural accuracy or live tracking without evidence. Do not add secrets or patient information. Adding/restructuring tasks requires an explicitly coordinated board migration; `init` never overwrites a live board.

## Paste into a new agent

“Clone https://github.com/wiltobuild/supply-vanguard, read AGENTS.md and the implementation plan, then use the board CLI to claim the next ready task with my owner name and a unique agent ID. Confirm the claim before editing. Implement its acceptance criteria in a separate branch, test, open a PR and submit the task for review. Heartbeat the lease every 30 minutes. Stop if the claim is lost.”
