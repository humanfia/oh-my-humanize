Ask the human operator two focused questions before the RLCR loop starts.

Current durable Humanize state:

```json
{{jsonStringify humanize}}
```

The questions should verify:

1. Which components the plan changes.
2. How the changed components connect.
3. Whether this run is intended to be long-running validation. In OMH,
   long-running means the Project x Flow x Task remains active for more than
   eight hours; eight hours is the minimum, and the default maximum is five
   days.

The human response must explicitly choose proceed, hold for clarification, or
stop. Prefer this first line exactly:

`Decision: proceed`

Use `Decision: hold` or `Decision: stop` when the checks are not satisfied.
When adding context in the OMH TUI, keep it on the same line after the decision
because custom gate input is line-oriented, for example
`Decision: proceed; components=...; connections=...; evidence=canary`.
The default Approve action means proceed only after the operator has read these
checks. Do not treat silence or ambiguity as implicit approval. If the answer is
weak, explain the plan and ask whether to proceed, hold, or stop.
