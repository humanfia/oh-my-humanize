Implement or refine exactly one KDA candidate for the current project.

Contract:
{{taskContract}}

Plan:
{{plan}}

Nested Humanize handoff:
{{humanizeHandoff}}

Work in the current project directory. Choose the next candidate that the plan
marks as highest value or unresolved. Keep the change bounded and reversible:

- identify the candidate name and hypothesis;
- incorporate the nested Humanize handoff instead of redoing or ignoring that
  work;
- make the smallest coherent code, test, config, benchmark, or evidence change
  needed to evaluate that candidate;
- run the validation or benchmark command declared by the contract when
  practical;
- record changed files, command output summaries, metrics, failures, and
  rollback notes;
- do not promote the candidate yourself.

If the candidate cannot be evaluated because required project information is
missing, produce a blocker summary and the exact missing input instead of making
an unrelated change.
