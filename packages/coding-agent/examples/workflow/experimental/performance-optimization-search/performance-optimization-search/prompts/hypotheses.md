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

The task contract JSON contains `scratchRoot`; branch clones or scratch copies,
benchmark fixtures, and apply-check directories must live under that absolute
path. Do not use bare `/tmp` or shared sibling scratch such as
`../workflow-scratch`.
Do not plan `git worktree add` from the shared task checkout: it mutates the
shared checkout's `.git/worktrees` metadata. Branches should use independent
scratch copies or `git clone --no-hardlinks` under `task.scratchRoot`.
Do not create writable bare `/tmp` sandbox mounts either; commands such as
`bwrap --tmpfs /tmp`, `--bind /tmp`, `--dir /tmp`, or `TMPDIR=/tmp` are invalid
even when another environment variable points at `task.scratchRoot`.
The shared project directory is for read-only inspection and durable
`workflow-output/` artifacts. Each branch's build, benchmark, validation,
apply-check, and candidate execution commands must run from a lane-local
clone or copy under `task.scratchRoot`, not from `cwd: .` or the shared task
workspace. Scratch-workspace creation itself must not mutate shared git
metadata.

If the previous performance review is a selection/rollback repair request after
a passing benchmark and validation, do not invent a new broad optimization
search. Instead, write a compact repair plan assigning the three branches to
retain, revert, or document no-win evidence for their existing work.

Do not edit project files in this node.
