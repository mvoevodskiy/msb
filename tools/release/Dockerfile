# Local Linux checks only; the target JAR1 gate still runs on its actual runtime.
# Base inspected: Node v22.23.2 / Linux arm64. No bot data or host HOME copied.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:f576cc608b02e6b04bb0700e13be83eb5ceb7bb24584c3181b0f4ecfa0cd0edf
FROM ${NODE_IMAGE}
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 git make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/msb-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force
WORKDIR /stage
