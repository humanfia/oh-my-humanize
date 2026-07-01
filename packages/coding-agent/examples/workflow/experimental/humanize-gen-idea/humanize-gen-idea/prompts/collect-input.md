# Humanize Gen Idea Input

Enter native `/humanize:gen-idea` arguments as custom input:

```text
"<idea-text-or-path>" [--n <int>] [--output <path>]
```

Rules:
- First positional = inline idea text or existing `.md` path.
- Quote multi-word inline ideas.
- `--n` range = 2..10; default = 6.
- `--output` default = `.humanize/ideas/<slug>-<timestamp>.md`.

Examples:

```text
"add undo/redo to the editor" --n 4
```

```text
notes/rough-idea.md --output docs/idea-draft.md
```

Important TUI detail:
- Select `Other` / custom input and type the argument string.
- Do not choose `Decision: proceed`; that is a generic workflow gate option, not an argument.
- Prefer `.humanize/gen-idea.args` for headless runs or if your TUI surface does not expose custom input clearly.