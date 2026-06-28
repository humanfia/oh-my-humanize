You are one optimization branch in a measured performance search flow.

Strategy: {{strategy}}

Task contract:
{{jsonStringify task}}

Baseline evidence:
{{jsonStringify baseline}}

Shared hypotheses:
{{jsonStringify hypotheses}}

Previous review, if any:
{{jsonStringify review}}

The workflow runtime runs this branch in an isolated lane worktree and captures
its diff as branch state metadata such as `patchPath`; it does not apply branch
changes back to the shared workspace before the join. Treat your current
directory as lane-local. Keep any additional scratch copy or benchmark fixture
outside the project tree and scoped to this workflow run. Use the
absolute `task.scratchRoot` value from the task contract JSON, for example
`<task.scratchRoot>/{{strategy}}-*`, when you need extra scratch beyond the
current OMH-managed isolated worktree. Do not try to rediscover this from the
shell environment. Never use bare `/tmp`, shared sibling scratch such as
`../workflow-scratch`, or any scratch root outside `task.scratchRoot` or the
current OMH-managed isolated lane worktree.
Do not run `git worktree add` from the shared task checkout: it mutates the
shared checkout's `.git/worktrees` metadata even when the new worktree path is
under `task.scratchRoot`. Use the current OMH-managed isolated worktree, an
independent scratch copy, or `git clone --no-hardlinks` into a lane directory
under `task.scratchRoot` instead.
Never create a writable bare `/tmp` execution surface inside a sandbox. Commands
such as `bwrap --tmpfs /tmp`, `--bind /tmp`, `--dir /tmp`, or `TMPDIR=/tmp`
are invalid; bind or mount a lane directory under `task.scratchRoot` instead.
Never place lane-local execution scratch, benchmark fixtures, or worktrees
under `workflow-output/tmp` or another project-scanned path. Apply the candidate
only in the current isolated lane worktree or an external scratch workspace,
and export the durable candidate patch plus measurements into
`workflow-output/`. Before yielding, verify the lane worktree diff and record
exactly which files belong to this branch. If a candidate cannot be tested
without mutating another branch's shared files, record the conflict in
`workflow-output/perf-{{strategy}}.md` instead of editing shared state.
Do not run branch build, benchmark, validation, apply-check, candidate
execution, or scratch-workspace creation commands from `cwd: .` or the shared
task workspace. Those commands must run from the current OMH-managed isolated
lane worktree or from an extra lane-local clone or copy under `task.scratchRoot`.

When you create a candidate patch, preserve enough evidence for selection:

- a strategy-scoped candidate patch path such as
  `workflow-output/perf-{{strategy}}-candidate.diff`;
- the exact command used to apply-check the patch in a clean checkout, including
  `git apply --check <candidate patch>`;
- benchmark or validation logs from the OMH-managed isolated lane worktree or a
  project-external lane-local scratch workspace, with command cwd/worktree paths
  scoped to the OMH-managed isolation root or `task.scratchRoot`;
- stdout/stderr equivalence evidence when the benchmark observes program output.

If the previous review or shared hypotheses ask for selection/rollback repair,
do not start a fresh broad optimization attempt. Limit this branch to the
requested retain/revert/no-win evidence work, update its branch note, and avoid
touching files owned by another branch.

Before yielding, write `workflow-output/perf-{{strategy}}.md` with:

- files changed or intentionally left unchanged;
- the expected performance mechanism;
- candidate patch path, or an explicit statement that no candidate patch was
  produced;
- OMH-managed isolated lane worktree path or project-external run-local scratch
  path and the `git apply --check` result when a candidate patch exists; any
  extra scratch path must be under `task.scratchRoot`;
- benchmark, validation, build, and apply-check command cwd values, all under
  the OMH-managed isolated lane worktree or `task.scratchRoot` when those
  commands were run;
- rollback instructions for this branch;
- `final-selection: yes` only if this branch is the single retained candidate
  after the selection/repair node applies it in the shared workspace;
- `final-selection: no` for losing, reverted, conflict-only, or no-win
  branches;
- `no-win-result: yes` only when the task contract explicitly contains
  `No-Win Result: allowed`, `No-Code/No-Change Allowed: Yes`,
  `No-Code Allowed: Yes`, or unambiguously says to archive or accept a no-win
  result when no safe positive candidate exists; the branch made or retained no
  project changes; and measured evidence shows no safe positive optimization
  for this branch;
- benchmark or validation commands you ran, if any.

Do not fabricate measurements. The workflow will run the task-declared
Benchmark Command and Validation Command after the branches join.
