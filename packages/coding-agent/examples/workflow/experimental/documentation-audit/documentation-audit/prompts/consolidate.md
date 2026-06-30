Consolidate the three documentation audits into one repair plan.

Task:

{{jsonStringify task}}

Bounded audit digest, including the inventory summary and lane findings:

{{jsonStringify auditDigest}}

Prior review feedback, if any:

{{jsonStringify review}}

Deduplicate findings, rank by user impact, and select the smallest coherent
documentation repair that can be validated by the task-declared commands.
When prior review feedback contains a `continue` decision, do not widen back
out into a new discovery pass. Treat that feedback as the repair backlog:
select only the smallest coherent remaining items needed to satisfy the
reviewer, or mark the blocked item and blocker explicitly.
Return changed-file targets, acceptance criteria, and rollback notes.

Do not create, edit, or delete any files in this node, including files under
`workflow-output`. Return the consolidated audit through the workflow state
handoff only.
