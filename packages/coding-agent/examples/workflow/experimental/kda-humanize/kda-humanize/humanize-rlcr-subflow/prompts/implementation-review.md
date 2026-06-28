Review this implementation round against the KDA plan and goal tracker.

{{summary}}

The goal tracker is a refreshed evidence index, not the only source of truth.
If a tracker field is stale, use the latest implementation summary, changed
files, validation artifacts, and workflow-output evidence to identify the
bookkeeping gap; do not reject real work only because a tracker label lagged.

Use:

- `CONTINUE` when another implementation round is needed for missing
  acceptance evidence, failed validation, unresolved risks, or incomplete scope;
- `COMPLETE` when the candidate is coherent enough to move to code-review
  remediation;
- `STOP` when the plan is unsafe, off-scope, or blocked on human input.
- `STOP` when the latest implementation summary is a terminal rejection, such
  as `status: "completed_rejected"` or `promotion_decision: "rejected"`, and
  it includes exact blocker evidence, changed-file inventory, rollback notes,
  and no project diff. A terminal rejection is a valid handoff to the outer KDA
  flow; do not loop just to spend more time on a candidate whose validation
  cannot start or whose promotion was explicitly rejected. Return `STOP` for
  this terminal rejection.

Write findings first, then put exactly one token on the final non-empty line:
`CONTINUE`, `COMPLETE`, or `STOP`.

Use `CONTINUE` or `STOP` instead of `COMPLETE` when the round contains broad
formatter/style/import/order churn, unrelated cleanup, generated-file churn, or
a diff much wider than the KDA acceptance surface. Large mechanical churn is not
candidate progress unless the plan explicitly asks for that migration.
