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
  ]{{#unless readOnlyWorkspace}},
  "artifacts": ["workflow-output/example.md"]{{/unless}}
}
```

Rules:
- Workspace access: {{workspaceAccess}}.
- Every `statePatch[].path` must be one of the declared write pointers.
- Include a `statePatch` entry for each declared write pointer that this node is
  responsible for producing.
{{#if readOnlyWorkspace}}
- Do not create, edit, or delete files. Do not write workflow-output files. This
  node is declared read-only, so any file write changes the workspace and fails
  the workflow.
- Keep large prose bounded inside the declared workflow state. If the detail is
  too large, summarize it and rely on the automatically attached
  `agent-output://...` transcript artifact for the full node transcript.
- If you need a durable file artifact, report that need in the declared state
  instead of writing the file yourself; a later write-capable or script node must
  materialize it.
{{else}}
- Put large prose, logs, or transcripts in files and reference them through
  `artifacts`; keep `summary` and inline `value` fields bounded and structured.
- Artifact references must be absolute paths, `workflow-output/...`,
  `local://...`, `artifact://...`, or `agent-output://...`. Use
  `local://progress.md` for root-level task progress, never bare
  `progress.md`. Use `workflow-output/round-1/validation-stdout.txt` for files
  under `workflow-output/`.
{{/if}}
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
