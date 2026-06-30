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
- Do not install or mutate system-wide dependencies. Do not use `sudo`, global
  package installs, `--break-system-packages`, `apt`, `brew`, `npm -g`, or
  equivalent host-level changes unless the operator-owned task contract
  explicitly authorizes that exact action.
- If a dependency or runner is missing, prefer the project-local environment
  declared by the repository. If that still cannot start, report a blocked
  state through the declared workflow output instead of repairing the host.

Declared write pointers: {{declaredWrites}}
