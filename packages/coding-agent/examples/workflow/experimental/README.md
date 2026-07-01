# Experimental Workflows

These workflows are generic enough to run through `OMHFLOW_DIR`, but they are
not formally promoted built-ins. Some have recent real Project x Flow x Task
evidence; seeded flows still need a fresh canary-grade success sample or a
recorded-and-repaired defect before they should be scaled. Promotion to
`packages/coding-agent/examples/workflow/<flow>/` requires at least 100
cumulative successful hours, transcript audit, meaningful multi-node work, and
no unresolved OMH infra defect.

Current promoted built-ins: none.

| Flow | Why it is experimental | Missing before promotion |
| --- | --- | --- |
| `agent-build-review-loop` | Real build/review loop evidence on HTTPX plus recent Vite semantic canaries. | 100h cumulative clean evidence across diverse contexts. |
| `humanize-rlcr` | Real RLCR-style implementation/review evidence and recent Axum semantic canaries. | Longer clean current-commit evidence and broader contexts. |
| `humanize-gen-idea` | Workflow-native port of Humanize `/humanize:gen-idea`; initial canary only. | Fresh long-running evidence across diverse repositories and generated-draft audits. |
| `kda-humanize` | Nested subflow composition and KDA-style candidate validation evidence. | Fresh clean long-running runs after recent KDA flow-control repairs. |
| `parallel-implementation-review` | Real parallel implementation/review evidence and repaired durable final archive contract. | Fresh clean long-running runs after finalizer repair. |
| `bug-triage-repro-fix` | Seeded candidate for reproduce-first bug repair. | First fresh canary-grade success sample or recorded-and-repaired defect. |
| `documentation-audit` | Seeded candidate for project-scoped documentation consistency repair. | First fresh canary-grade success sample or recorded-and-repaired defect. |
| `refactor-migration-plan` | Seeded candidate for serial migration planning and compatibility repair. | First fresh canary-grade success sample or recorded-and-repaired defect. |
| `release-hardening` | Seeded candidate for release-readiness hardening. | First fresh canary-grade success sample or recorded-and-repaired defect. |
| `test-generation-hardening` | Seeded candidate for regression-oriented test expansion. | First fresh canary-grade success sample or recorded-and-repaired defect. |
| `performance-optimization-search` | Seeded candidate for measured optimization search. | First fresh canary-grade success sample or recorded-and-repaired defect. |
| `research-reproduction` | Seeded candidate for command-backed claim reproduction. | First fresh canary-grade success sample or recorded-and-repaired defect. |

Do not treat this directory as a stability guarantee. If a flow shows a
flow-library defect during Phase 3, repair and recanary it before using it in a
larger fanout.
