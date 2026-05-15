# NanoClaw OpenAI-Compatible Agent Container
#
# Runs the openai Node SDK against any provider that exposes an
# OpenAI-shaped /chat/completions endpoint — Gemini's compat layer,
# OpenAI itself, OpenRouter, Together AI, Groq, Ollama, vLLM, etc.
#
# Mirrors `container/Dockerfile` (the Claude image) intentionally: same
# base, same entrypoint script, same /workspace layout, same OUTPUT
# marker contract. Only the SDK underneath changes.
#
# See docs/PROVIDER_PLAYBOOK.md § 4.1 (Container contract) and
# docs/implementation/gemini-blueprint.md § 3 (Phase A).

FROM node:22-slim

# Install minimum system dependencies. We keep this image lean: the
# Claude container bundles Chromium + PDF tools because the Claude
# Agent SDK has built-in computer-use / read-PDF capabilities. The OAI
# wire protocol's tool surface is whatever the operator's chosen
# provider supports — a basic function-calling loop, not a kitchen sink.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

# App directory.
WORKDIR /app

# Copy package files first for better caching.
COPY agent-runner/package*.json ./

# Install dependencies.
RUN npm install

# Copy source code.
COPY agent-runner/ ./

# Build TypeScript.
RUN npm run build

# Create workspace directories.
RUN mkdir -p /workspace/group /workspace/global /workspace/extra \
             /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script that mirrors the Claude container's shape so
# the orchestrator can spawn either image with identical command-line.
# Container input (prompt, group info) is piped in via stdin JSON.
# Credentials are injected by the OneCLI proxy — never passed here.
# Streaming output goes to stdout between OUTPUT_START / OUTPUT_END
# markers; the orchestrator parses them out of the stream.
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories.
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user.
USER node

# Set working directory to group workspace.
WORKDIR /workspace/group

# Entry point reads JSON from stdin, writes JSON to stdout (between
# OUTPUT_START_MARKER / OUTPUT_END_MARKER lines).
ENTRYPOINT ["/app/entrypoint.sh"]
