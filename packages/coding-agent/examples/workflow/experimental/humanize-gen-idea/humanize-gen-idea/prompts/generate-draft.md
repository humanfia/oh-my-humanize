# Generate Humanize Idea Draft

Validated input:

```json
{{jsonStringify idea}}
```

## Hard Constraint: Draft-Only Output

You MUST NOT implement features, modify source code, or create commits. The only permitted project write is the final draft file at `idea.outputFile`. Do not write workflow-output artifacts.

This workflow transforms a loose idea into a repo-grounded draft suitable as the task contract for experimental `humanize-rlcr`: review/copy the saved draft to `task.md` or `TASK.md`, then start `/workflow start experimental::humanize-rlcr`. It applies directed-diversity exploration: pick `idea.n` orthogonal directions, launch `idea.n` read-only exploration subagents in one Task-tool call, then synthesize one primary direction plus alternatives. Every direction MUST carry objective evidence from this repo or the sentinel `exploratory, no concrete precedent`.

## Inputs

- Original idea body: `idea.ideaBody` for inline input, or `idea.ideaBodyFile` for file input.
- Output draft file: `idea.outputFile`.
- Draft template file: `idea.templateFile`.
- Direction count: `idea.n`.
- Validation warnings: `idea.warnings`.

Before doing anything else, load the original idea body: use `idea.ideaBody` when present, otherwise read `idea.ideaBodyFile`. Preserve it byte-identically when populating `<ORIGINAL_IDEA>`.

## Phase 1: Context

Read, when present:
- `README.md` at the project root.
- `CLAUDE.md` at the project root.
- `.claude/CLAUDE.md`.
- One-level top-level project listing.

Use this context only to ground directions. Do not inspect unrelated deep trees unless a direction needs evidence.

## Phase 2: Direction Generation

Generate exactly `idea.n` orthogonal directions.

Each direction has:
- `name`: 2-5 word short label.
- `rationale`: one sentence explaining why this angle is distinct.

Hard constraint: orthogonality. Near-duplicates defeat the workflow.
- Duplicate angles? Replace one.
- "Just do X better"? Replace it.
- Restatement of the original idea? Replace it.

Retry once if fewer than `idea.n` directions are produced. If the retry still returns fewer than requested but at least 2, proceed with the reduced count and mention the warning in your final response. If fewer than 2 directions remain, stop without writing `idea.outputFile` and report `direction generation degraded; retry.`

## Phase 3: Parallel Exploration

Dispatch all directions in a single Task-tool call: one read-only Explore subagent per direction.

Each subagent prompt MUST include:
1. The verbatim original idea body loaded from `idea.ideaBody` or `idea.ideaBodyFile`.
2. The assigned direction name + rationale.
3. This exact instruction block:

> Explore this direction within the current repo. Gather OBJECTIVE EVIDENCE:
> - Specific repo paths with existing patterns worth extending.
> - Prior art or precedent in the codebase or adjacent tooling.
> - Measurable considerations (approximate complexity, LOC surface, performance implications) where discoverable from reading the code.
>
> Read-only. Do not write any files. Do not run tests, linters, formatters, or project-wide commands.
>
> If no concrete evidence exists for this direction, report the literal string `exploratory, no concrete precedent` once in OBJECTIVE_EVIDENCE and stop exploring further. Fabrication of references is forbidden.
>
> Return a structured proposal with exactly these fields:
> - `APPROACH_SUMMARY`: concrete design description (what to build, core mechanism, affected components).
> - `OBJECTIVE_EVIDENCE`: bullet list of repo paths, prior art, or the `exploratory, no concrete precedent` sentinel.
> - `KNOWN_RISKS`: short bullet list.
> - `CONFIDENCE`: one of `high`, `medium`, `low`.

Drop degraded proposals with missing fields. If fewer than 2 proposals survive, stop without writing `idea.outputFile` and report `exploration phase degraded; retry.`

## Phase 4: Synthesis and Write

Choose the primary proposal by:
1. Evidence density.
2. Fit with existing repo patterns.
3. Smaller implementation surface when quality is comparable.
4. Confidence as tie-breaker: `high` > `medium` > `low`.

Generate a 4-10 word Title Case title that captures the primary direction, not the original phrasing verbatim.

Read `idea.templateFile`. Replace placeholders:
- `<TITLE>` — inferred title.
- `<ORIGINAL_IDEA>` — byte-identical original idea body loaded from `idea.ideaBody` or `idea.ideaBodyFile`.
- `<PRIMARY_NAME>` — primary direction name.
- `<PRIMARY_RATIONALE>` — primary direction rationale.
- `<PRIMARY_APPROACH_SUMMARY>` — primary proposal `APPROACH_SUMMARY`.
- `<PRIMARY_OBJECTIVE_EVIDENCE>` — primary `OBJECTIVE_EVIDENCE` as bullets; sentinel renders as `- exploratory, no concrete precedent`.
- `<PRIMARY_KNOWN_RISKS>` — primary `KNOWN_RISKS` as bullets.
- `<ALTERNATIVES>` — one section per non-primary survivor:

```markdown
### Alt-<i>: <name>
- Gist: <one-paragraph summary derived from APPROACH_SUMMARY>
- Objective Evidence:
  - <bullet from OBJECTIVE_EVIDENCE>
- Why not primary: <one sentence stating the tradeoff vs PRIMARY>
```

Separate alternatives with one blank line. Renumber alternatives sequentially without gaps.

- `<SYNTHESIS_NOTES>` — one paragraph describing which alternative elements could fold into the primary if the user chose a different direction.

Write `idea.outputFile` exactly once. Then report:
- Path written.
- Primary direction name.
- Requested `idea.n` and actual surviving direction count.
- Validation warnings, if any.