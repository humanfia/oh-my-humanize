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

Submit one terminal `yield` tool call. Put exactly this object in `result.data`:

```json
{
  "overall_correctness": "correct" | "incorrect",
  "explanation": "verdict <gate>\nConcise evidence for the workflow decision.",
  "confidence": 0.0-1.0
}
```

Do not submit separate section yields. Do not use `type:
["overall_correctness"]`, `type: ["explanation"]`, or `type: ["confidence"]`
for this review node. Do not wrap this object in another `result` object. The
three reviewer fields must be the top-level data fields of the terminal result.

Use `"correct"` when the workflow should take the successful/terminal gate, or
`"incorrect"` when it should take the repair/retry gate. The first line of
`explanation` must be exactly `verdict <gate>`, where `<gate>` is one of the
declared workflow gates.

All three fields are required. If the final result only contains
`overall_correctness` or omits `explanation` / `confidence`, OMH will treat it
as a schema contract failure: the review may be retried, and an exhausted
payload with a clear reviewer correctness signal is recovered as a degraded,
audited workflow verdict instead of a clean review.

Declared workflow gates: {{declaredGates}}
Fallback verdict: {{fallbackVerdict}}
