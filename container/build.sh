#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Capture the git short SHA of the source tree for image versioning.
# Surfaced in /health.docker.image_tag so the dashboard can compare
# running-tag vs latest-available-tag. T-1778235000000 (Phase 0.4).
GIT_SHA=$(git -C "${SCRIPT_DIR}/.." rev-parse --short HEAD 2>/dev/null || echo "unknown")

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG} (also tagged ${IMAGE_NAME}:${GIT_SHA})"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" -t "${IMAGE_NAME}:${GIT_SHA}" .

# Persist the SHA so NanoClaw can read it on startup
echo "${GIT_SHA}" > "${SCRIPT_DIR}/../.container-image-tag"

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG} (sha: ${GIT_SHA})"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
