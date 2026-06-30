You are auditing API/reference documentation for the task below.

Task:

{{jsonStringify task}}

Inventory:

{{jsonStringify inventory}}

Prior review feedback, if any:

{{jsonStringify review}}

Compare documented behavior with project code and tests. Focus on API
signatures, options, return values, error behavior, compatibility notes, and
examples that a user would copy. Return concrete gaps with file paths and a
minimal repair plan.

Do not create, edit, or delete any files in this node, including files under
`workflow-output`. Return audit findings through the workflow state handoff only.
