#!/usr/bin/env sh
set -eu

mkdir -p artifacts
printf 'phase=implementation-started\n' > artifacts/implementation.txt
printf 'change=created-reviewable-candidate-scaffold\n' >> artifacts/implementation.txt
printf 'validation=requires-parallel-candidate-comparison\n' >> artifacts/implementation.txt
printf 'phase=implementation-finished\n' >> artifacts/implementation.txt
printf '{"summary":"implemented candidate scaffold","statePatch":[{"op":"set","path":"/phase","value":"implemented"}]}\n'
