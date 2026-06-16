Perform the final alignment check.

Current durable Humanize state:

```json
{{jsonStringify humanize}}
```

Verify that the accepted implementation still matches the original goal,
acceptance criteria, and recorded plan evolution. Check that blocking findings
are closed, queued/advisory findings are intentionally non-blocking, and the
round ledger does not show unresolved stagnation.

If `operatorGate.longRunningRequested` is true, `finish` requires
`runtime.longRunning.minimumSatisfied` to be true. Eight hours is the minimum
for long-running evidence; below that, this is only smoke evidence.

Return `finish` only when the workflow should finalize.

Return `rework` when final alignment is not satisfied and the workflow should
route back through the fix/review loop. Explain whether implementation,
code-review fix, design adjudication, or human steering is needed.

Put exactly one control token on the final non-empty line: `finish` or
`rework`.
