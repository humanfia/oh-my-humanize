Execute the full implementation plan for this round.

Current durable Humanize state:

```json
{{jsonStringify humanize}}
```

Maintain the goal tracker and work delta-first. Route coding tasks to
implementation work, route analysis tasks to review consultation, and write
enough evidence for Codex-style summary review to judge whether every acceptance
criterion is complete.

Delta discipline is part of the task contract:

- If `humanize.diffGuard.verdict` is `REPAIR`, treat its reasons as blocking
  instructions for this round. First revert or narrow the unrelated mechanical
  churn it identified, then continue only with acceptance-tied edits.
- Do not run whole-repository formatters, style rewriters, import organizers, or
  mechanical migrations unless the task explicitly asks for that project-wide
  change.
- Format only files you intentionally changed, and only in the repository's
  existing style. If a formatter would touch unrelated files, stop, revert the
  unrelated churn, and report the formatter risk.
- Keep the diff tied to acceptance criteria. Broad whitespace/import/order churn,
  line-ending churn, generated-file churn, or unrelated cleanup is not progress.
- Before yielding, inspect `git status --short --untracked-files=all` and
  both `git diff --stat` and `git diff -w --stat`. If raw diff size is much
  larger than the `-w` diff, or if task.md declares a whitespace/formatter
  percentage budget that you exceed, first revert the mechanical churn and
  redo the semantic change narrowly. Do not finish the round with formatter
  churn for the guard to discover later.
- Revert formatter-wide indentation, import ordering, line wrapping, or
  whitespace churn immediately unless that exact mechanical migration is the
  accepted task. If the semantic change cannot be separated from the formatter
  churn, stop and ask for steering instead of continuing.
- Revert or justify every changed project file. If the diff is broader than the
  acceptance surface, ask for human steering instead of continuing.
- If you run validation, copy the raw stdout and stderr into durable
  workspace-local files under `workflow-output/` and reference those paths in
  your evidence. Do not cite transient `artifact://...` handles for validation,
  status, stdout, stderr, or evidence; downstream guards reject nondurable
  artifact references before summary review.


Before claiming completion, provide:

- acceptance-criteria evidence,
- negative-test or regression-risk scenarios,
- verification commands or a clear reason they cannot run,
- changed files,
- reviewer instructions from prior rounds marked fixed, deferred, or rejected.

Do not claim that `codexCodeReview`, `finalAlignmentCheck`, or any downstream
workflow node has passed or completed. Implementation evidence may prepare
review inputs only; review and final-alignment verdicts belong to the later
workflow nodes.

If the same conceptual issue has appeared before, do not point-fix blindly:
identify whether design/adjudication or human steering is needed.
