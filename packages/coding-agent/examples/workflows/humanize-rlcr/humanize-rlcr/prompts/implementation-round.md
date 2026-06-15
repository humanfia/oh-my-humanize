Execute the full implementation plan for this round.

Current durable Humanize state:

```json
{{jsonStringify humanize}}
```

Maintain the goal tracker and work delta-first. Route coding tasks to
implementation work, route analysis tasks to review consultation, and write
enough evidence for Codex-style summary review to judge whether every acceptance
criterion is complete.

If the durable state says `operatorGate.longRunningRequested` is true, this is
a long-running validation run. Eight hours is the minimum runtime; do not frame a
short smoke pass as final long-running completion.

Before claiming completion, provide:

- acceptance-criteria evidence,
- negative-test or regression-risk scenarios,
- verification commands or a clear reason they cannot run,
- changed files,
- reviewer instructions from prior rounds marked fixed, deferred, or rejected.

If the same conceptual issue has appeared before, do not point-fix blindly:
identify whether design/adjudication or human steering is needed.
