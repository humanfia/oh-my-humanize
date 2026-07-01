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

If the shared hypotheses object for strategy `{{strategy}}` has a `status`
containing `blocked`, `no-win`, `no_win`, `negative`, or equivalent wording,
this branch is not authorized to create a positive candidate. Do not edit
project files, do not write a candidate patch, and do not mark
`benchmark-relevance: yes` as retained positive evidence. Write only a durable
no-win/blocker branch report under `workflow-output/perf-{{strategy}}.md` with
the exact reason this branch is blocked for the current task.

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
- whether the task-declared Benchmark Command actually covers this candidate's
  mechanism. Record `benchmark-relevance: yes` only when the measured benchmark
  exercises the code path or behavior changed by the candidate. Record
  `benchmark-relevance: no` when the candidate may be useful but is outside the
  task benchmark.
- if `task.benchmarkTargetPaths` is non-empty, positive candidate work must edit,
  instrument, or directly prove behavior for one of those target paths. Do not
  mark wrapper, shim, or import-location changes as `benchmark-relevance: yes`
  unless the durable branch evidence explains how the declared target path is
  exercised by the candidate. If the real hot path is outside the allowed
  project paths, record a blocked/no-win branch instead of optimizing the
  wrapper.
- if `task.benchmarkSourceRoots` is non-empty, run your branch benchmark,
  validation, and semantic probes with those source roots bound into the import
  environment. Do not use default-environment measurements that imported a host
  site-packages package, globally installed package, or any source outside the
  task checkout as retained positive evidence.

If the previous review or shared hypotheses ask for selection/rollback repair,
do not start a fresh broad optimization attempt. Limit this branch to the
requested retain/revert/no-win evidence work, update its branch note, and avoid
touching files owned by another branch.
If the previous review or shared hypotheses contain `review_feedback_constraints`,
that feedback is mandatory for this branch when it touches the selected
candidate's area. Do not reselect a benchmark-fast candidate until you have
run the exact public-surface probe requested by the reviewer, or until you have
recorded why this branch rejects the candidate. If this branch claims the
feedback is resolved, write both markers in `workflow-output/perf-{{strategy}}.md`:
`review-feedback-addressed: yes` and `review feedback evidence: ...` with the
actual probe, command, or test result. If the feedback is not applicable to
this branch, write `review-feedback-addressed: not-applicable` plus the reason.

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
- `benchmark-relevance: yes` or `benchmark-relevance: no`, plus one sentence
  explaining what benchmark path is or is not covered;
- when `task.benchmarkTargetPaths` is non-empty, the target path touched or
  explicitly probed by this branch, or why this branch is blocked/no-win;
- when `task.benchmarkSourceRoots` is non-empty, the source-root-bound command
  environment used for measurements, or why this branch produced no positive
  measurement;
- when previous review feedback exists, `review-feedback-addressed: yes` with
  concrete evidence for the selected candidate, or
  `review-feedback-addressed: not-applicable` with the reason for losing/no-win
  branches;
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

If a benchmark, validation, or tool invocation times out after you have already
written durable branch evidence, make at most one focused recovery attempt. If
that recovery also times out or is not needed to make the branch decision, update
`workflow-output/perf-{{strategy}}.md` with the timeout evidence, classify the
candidate as retained, reverted, conflict-only, or no-win, and yield instead of
continuing open-ended probing.

Do not fabricate measurements. The workflow will run the task-declared
Benchmark Command and Validation Command after the branches join.
