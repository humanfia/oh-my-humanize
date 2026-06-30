Use the task contract below as the authoritative documentation-audit scope.

Task:

{{jsonStringify task}}

Inspect the current project directory and identify the documentation surfaces
that matter for this task: API/reference docs, tutorials/guides, examples, CLI
help, README material, changelog notes, and generated docs commands if present.

Return a concise structured inventory with files, commands worth running, and
risks for stale or missing documentation. Do not invent a validation command;
the task contract already provides it.

Do not create, edit, or delete any files in this node, including files under
`workflow-output`. Return the inventory through the workflow state handoff only.
