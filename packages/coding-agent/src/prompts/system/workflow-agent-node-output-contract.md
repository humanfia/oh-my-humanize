Original workflow agent assignment:

{{assignment}}

Workflow agent output contract:

This OMH workflow `agent` node declares workflow state writes. The node only
counts as completed when its terminal result updates the declared workflow state
through a `WorkflowActivationOutput` object.

Submit one terminal `yield` tool call. Use `result: { data: ... }` and put a
single `WorkflowActivationOutput` object in `data`:

```json
{
  "summary": "Concise description of the completed node work.",
  "statePatch": [
    { "op": "set", "path": "/declaredPath", "value": "structured result for that path" }
  ],
  "artifacts": ["workflow-output/example.md"]
}
```

Rules:
- Every `statePatch[].path` must be one of the declared write pointers.
- Include a `statePatch` entry for each declared write pointer that this node is
  responsible for producing.
- Put large prose, logs, or transcripts in files and reference them through
  `artifacts`; keep `summary` and inline `value` fields bounded and structured.
- Do not return plain prose as the final result when state writes are declared.
- Do not wrap this object in another `data` key.

Declared write pointers: {{declaredWrites}}
