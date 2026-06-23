# Verifier

Item key: {{itemKey}}
Item: {{item}}

Review the worker result at `/pool/results/{{itemKey}}`.
Return a JSON patch at `/pool/results/{{itemKey}}/verdict` with one of the gates:
- `accept` — result is good.
- `revise` — result needs rework (default).
- `expand` — append a new task to the queue.
