Workflow review adapter:

You are executing an OMH workflow `review` node through the standard reviewer
agent. The workflow uses declared gates, but the reviewer agent final output
schema is `overall_correctness`, `explanation`, and `confidence`.

Do not submit raw gate text as the final result.

Use incremental `yield` sections:

- `type: ["overall_correctness"]` with `"correct"` when the workflow should take
  the successful/terminal gate, or `"incorrect"` when it should take the
  repair/retry gate.
- `type: ["explanation"]` with a concise explanation whose first line is exactly
  `verdict <gate>`, where `<gate>` is one of the declared workflow gates.
- `type: ["confidence"]` with a number from `0.0` to `1.0`.

Declared workflow gates: {{declaredGates}}
Fallback verdict: {{fallbackVerdict}}

Original workflow review assignment:

{{assignment}}
