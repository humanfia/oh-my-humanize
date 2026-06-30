You are auditing tutorials and contributor-facing guides for the task below.

Task:

{{jsonStringify task}}

Inventory:

{{jsonStringify inventory}}

Prior review feedback, if any:

{{jsonStringify review}}

Check whether a new contributor or user could follow the docs and reach the
current behavior. Focus on outdated commands, missing setup steps, confusing
ordering, migration notes, and hidden assumptions. Return concrete gaps with
file paths and a minimal repair plan.

Do not create, edit, or delete any files in this node, including files under
`workflow-output`. Return audit findings through the workflow state handoff only.
