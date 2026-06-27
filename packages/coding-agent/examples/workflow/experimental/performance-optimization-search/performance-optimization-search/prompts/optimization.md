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

Work from the current project directory, but keep the shared workspace clean.
Do not leave project-file edits in the shared workspace. For any code
candidate, create a lane-local scratch copy or git worktree outside the project tree
and scoped to this workflow run. Use the absolute `task.scratchRoot` value from
the task contract JSON, for example `<task.scratchRoot>/{{strategy}}-*`. Do not
try to rediscover this from the shell environment. Never use bare `/tmp`, shared
sibling scratch such as `../workflow-scratch`, or any scratch root outside
`task.scratchRoot`.
Never create a writable bare `/tmp` execution surface inside a sandbox. Commands
such as `bwrap --tmpfs /tmp`, `--bind /tmp`, `--dir /tmp`, or `TMPDIR=/tmp`
are invalid; bind or mount a lane directory under `task.scratchRoot` instead.
Never place lane-local execution scratch, benchmark fixtures, or worktrees
under `workflow-output/tmp` or another project-scanned path. Apply the candidate
only in that external scratch
workspace, and export the durable candidate patch plus measurements into
`workflow-output/`. Before yielding, verify the shared workspace has no
project-file diff with `git diff HEAD --name-only` except `workflow-output/`
artifacts and `task.md`. If a candidate cannot be tested without mutating
another branch's shared files, record the conflict in
`workflow-output/perf-{{strategy}}.md` instead of editing the shared workspace.

When you create a candidate patch, preserve enough evidence for selection:

- a strategy-scoped candidate patch path such as
  `workflow-output/perf-{{strategy}}-candidate.diff`;
- the exact command used to apply-check the patch in a clean checkout, including
  `git apply --check <candidate patch>`;
- benchmark or validation logs from the project-external lane-local scratch
  workspace, with scratch paths scoped to `task.scratchRoot`;
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
- project-external run-local scratch path and the `git apply --check` result
  when a candidate patch exists; the scratch path must be under `task.scratchRoot`;
- rollback instructions for this branch;
- `final-selection: yes` only if this branch is the single retained candidate
  after the selection/repair node applies it in the shared workspace;
- `final-selection: no` for losing, reverted, conflict-only, or no-win
  branches;
- `no-win-result: yes` only when the task contract explicitly contains
  `No-Win Result: allowed`, `No-Code/No-Change Allowed: Yes`, or
  `No-Code Allowed: Yes`; the branch made or retained no project changes; and
  measured evidence shows no safe positive optimization for this branch;
- benchmark or validation commands you ran, if any.

Do not fabricate measurements. The workflow will run the task-declared
Benchmark Command and Validation Command after the branches join.
