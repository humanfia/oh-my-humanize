You are planning a measured performance optimization search.

Task contract:
{{jsonStringify task}}

Baseline evidence:
{{jsonStringify baseline}}

Previous performance review:
{{jsonStringify review}}

Inspect only enough project structure to define safe hypotheses. Return a
compact plan for three branches: algorithmic, caching, and IO. For each branch,
include likely files, expected metric movement, rollback risk, and conflicts
the parallel branches must avoid.

If `task.benchmarkTargetPaths` is non-empty, treat those paths as the measured
hot path for this run. Plan branch hypotheses around those targets, or state
that a branch is blocked/no-win because the useful implementation path is
outside the task contract. Do not plan wrapper, shim, or import-location edits
as positive optimization work unless the benchmark target paths also cover the
changed implementation path.

The workflow runtime branch isolation worktree is already a lane-local
execution surface. The task contract JSON also contains `scratchRoot`; extra
branch clones, scratch copies, benchmark fixtures, and apply-check directories
must live under that absolute path. Do not use bare `/tmp` or shared sibling
scratch such as `../workflow-scratch`.
Do not plan `git worktree add` from the shared task checkout: it mutates the
shared checkout's `.git/worktrees` metadata. Branches should use independent
scratch copies or `git clone --no-hardlinks` under `task.scratchRoot` only when
they need an extra copy beyond the OMH-managed isolated worktree.
Do not create writable bare `/tmp` sandbox mounts either; commands such as
`bwrap --tmpfs /tmp`, `--bind /tmp`, `--dir /tmp`, or `TMPDIR=/tmp` are invalid
even when another environment variable points at `task.scratchRoot`.
The shared project directory is for read-only inspection and durable
`workflow-output/` artifacts. Each branch's build, benchmark, validation,
apply-check, and candidate execution commands must run from the current
OMH-managed isolated lane worktree or from an extra lane-local clone or copy
under `task.scratchRoot`, not from `cwd: .` or the shared task workspace.
Scratch-workspace creation itself must not mutate shared git metadata.

If the previous performance review is a selection/rollback repair request after
a passing benchmark and validation, do not invent a new broad optimization
search. Instead, write a compact repair plan assigning the three branches to
retain, revert, or document no-win evidence for their existing work.

If the previous performance review says `continue`, `incorrect`, or names a
specific behavior risk, the next round is review-feedback repair, not a fresh
open search. Extract each concrete reviewer concern into explicit acceptance
criteria. For every named public surface, include the exact probe or test that
would prove it is fixed. Put those criteria in the returned plan under a
`review_feedback_constraints` field and assign branches only to repair or
disprove those constraints. A branch may still reject the previous candidate,
but it must explain how it addressed the reviewer concern.

Do not edit project files in this node.
