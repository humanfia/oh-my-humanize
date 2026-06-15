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

Return `finish` only when the workflow should finalize. If final alignment is
not satisfied, do not return `finish`; explain whether implementation,
code-review fix, design adjudication, or human steering is needed.
