Original workflow review assignment:

{{assignment}}

Workflow review adapter:

You are executing an OMH workflow `review` node through the standard reviewer
agent. The workflow uses declared gates, but the reviewer agent final output
schema is `overall_correctness`, `explanation`, and `confidence`.

The original assignment may ask for a plain-text gate such as `continue`,
`finish`, `PASS`, or `COMPLETE`. Treat that as the workflow verdict content,
not as the final transport format. Do not submit raw gate text as the final
result.

Use incremental `yield` sections:

- `type: ["overall_correctness"]` with `"correct"` when the workflow should take
  the successful/terminal gate, or `"incorrect"` when it should take the
  repair/retry gate.
- `type: ["explanation"]` with a concise explanation whose first line is exactly
  `verdict <gate>`, where `<gate>` is one of the declared workflow gates.
- `type: ["confidence"]` with a number from `0.0` to `1.0`.

All three sections are required. If the final result only contains
`overall_correctness` or omits `explanation` / `confidence`, OMH will treat it
as a schema contract failure: the review may be retried, and an exhausted
payload with a clear reviewer correctness signal is recovered as a degraded,
audited workflow verdict instead of a clean review.

Declared workflow gates: {{declaredGates}}
Fallback verdict: {{fallbackVerdict}}
