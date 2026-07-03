# Containerized install smoke for the release tarball topology.
#
# The authoritative install flow lives in scripts/install-tests/run-ci.sh. Keep
# this Dockerfile as a thin wrapper so the manual podman path exercises the same
# bun-pack tarballs, catalog/workspace dependency resolution, native leaf package,
# collab assets, and omh/omp smoke probes as CI.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    build-essential \
    ca-certificates \
    curl \
    git \
    jq \
    procps \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly
ENV PATH="/root/.cargo/bin:$PATH"

WORKDIR /repo
COPY . .

RUN bun install --frozen-lockfile
RUN scripts/install-tests/run-ci.sh
