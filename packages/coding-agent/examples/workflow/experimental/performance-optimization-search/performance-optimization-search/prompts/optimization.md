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

Work in the current project directory. Make the smallest change that tests the
assigned strategy. If another active branch has already touched the same file,
record the conflict in `workflow-output/perf-{{strategy}}.md` instead of
overwriting unrelated work.

If the previous review or shared hypotheses ask for selection/rollback repair,
do not start a fresh broad optimization attempt. Limit this branch to the
requested retain/revert/no-win evidence work, update its branch note, and avoid
touching files owned by another branch.

Before yielding, write `workflow-output/perf-{{strategy}}.md` with:

- files changed or intentionally left unchanged;
- the expected performance mechanism;
- rollback instructions for this branch;
- `final-selection: yes` only if this branch is the single retained candidate
  after reverting or isolating losing branch changes;
- `final-selection: no` for losing, reverted, conflict-only, or no-win
  branches;
- `no-win-result: yes` only when the task contract explicitly contains
  `No-Win Result: allowed`, the branch made or retained no project changes, and
  measured evidence shows no safe positive optimization for this branch;
- benchmark or validation commands you ran, if any.

Do not fabricate measurements. The workflow will run the task-declared
Benchmark Command and Validation Command after the branches join.
