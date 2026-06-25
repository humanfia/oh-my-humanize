You are planning a measured performance optimization search.

Task contract:
{{jsonStringify task}}

Baseline evidence:
{{jsonStringify baseline}}

Previous performance review:
{{jsonStringify review}}

Inspect only enough project structure to define safe hypotheses. Return a
compact plan for three branches: algorithmic, caching, and IO. For each branch,
include likely files, expected metric movement, rollback risk, and conflicts
the parallel branches must avoid.

If the previous performance review is a selection/rollback repair request after
a passing benchmark and validation, do not invent a new broad optimization
search. Instead, write a compact repair plan assigning the three branches to
retain, revert, or document no-win evidence for their existing work.

Do not edit project files in this node.
