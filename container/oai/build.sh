#!/bin/bash
# Build the NanoClaw OpenAI-compatible agent container image.
#
# Single image, many providers. After this image lands, every
# OpenAI-compatible provider (Gemini, OpenAI, OpenRouter, Together,
# Groq, Ollama, vLLM, etc.) is a data-only addition to
# setup/providers.json — no container rebuild required.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent-oai"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Capture the git short SHA so the dashboard can compare running tag
# vs latest-available tag — mirrors container/build.sh.
GIT_SHA=$(git -C "${SCRIPT_DIR}/../.." rev-parse --short HEAD 2>/dev/null || echo "unknown")

echo "Building NanoClaw OAI agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG} (also tagged ${IMAGE_NAME}:${GIT_SHA})"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" -t "${IMAGE_NAME}:${GIT_SHA}" .

# Persist the SHA so NanoClaw can read it on startup.
echo "${GIT_SHA}" > "${SCRIPT_DIR}/../../.container-image-oai-tag"

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG} (sha: ${GIT_SHA})"
echo ""
echo "Smoke test against Gemini:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' \\"
echo "    | ${CONTAINER_RUNTIME} run -i --rm \\"
echo "        -e MODEL=gemini/gemini-2.5-flash \\"
echo "        -e PROVIDER_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \\"
echo "        -e ONECLI_GATEWAY=http://host.docker.internal:10254 \\"
echo "        ${IMAGE_NAME}:${TAG}"
