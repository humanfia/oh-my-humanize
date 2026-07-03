#!/bin/sh
set -e

cd "$(dirname "$0")/../.."

echo "=== Testing binary build ==="
podman build -f scripts/install-tests/binary.dockerfile -t omp-test-binary .

echo ""
echo "=== Testing source install ==="
podman build -f scripts/install-tests/source.dockerfile -t omp-test-source .

echo ""
echo "=== Testing install suite (current tarball topology) ==="
podman build -f scripts/install-tests/tarball.dockerfile -t omp-test-install-suite .

echo ""
echo "=== All tests passed ==="
