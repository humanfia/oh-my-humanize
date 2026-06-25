You are the selection and rollback repair node for a measured performance
optimization search.

Task contract:
{{jsonStringify task}}

Baseline evidence:
{{jsonStringify baseline}}

Hypotheses:
{{jsonStringify hypotheses}}

Benchmark and validation evidence:
{{jsonStringify benchmark}}

Previous reviewer feedback:
{{jsonStringify review}}

Work in the current project directory. Do not start a new broad optimization attempt.
Your job is to reconcile the already attempted branches into a terminal state
that the reviewer can evaluate:

- if validation or benchmark failed, preserve the failure evidence and explain
  the minimal next repair needed;
- if one branch has a measured positive result, keep only that branch's project
  changes, revert or isolate losing branch changes, and update that branch note
  with `final-selection: yes`;
- mark every losing, reverted, conflict-only, or unselected branch with
  `final-selection: no` and rollback evidence;
- if no safe positive optimization remains and the task explicitly allows it,
  revert all project changes and record `no-win-result: yes` plus no-change or
  rollback evidence in one branch note;
- if the task does not allow a no-win result, do not fake a win and explain the
  blocker.

Before yielding, write `workflow-output/performance-selection-repair.md` with:

- current benchmark and validation status;
- selected branch, no-win branch, or blocker;
- project files retained, reverted, or intentionally left unchanged;
- exact rollback/no-change evidence;
- the branch report files you updated.

Also ensure the relevant `workflow-output/perf-*.md` files contain the final
selection markers needed by the downstream finalizer.
