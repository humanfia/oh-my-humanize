# Plan seed

Seed the plan and queue. Output a JSON patch that sets:
- `/plan` to an object with a `tasks` array containing `task-1` through `task-5`.
- `/pool/queue` to an array of objects `{ "id": "task-N" }` for N=1..5.
- `/pool/done` to `false`.
- `/pool/results` to `{}`.
