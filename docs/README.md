# NanoClaw Documentation

The official documentation is at **[docs.nanoclaw.dev](https://docs.nanoclaw.dev)**.

The files in this directory are original design documents and developer references. For the most current and accurate information, use the documentation site.

| This directory | Documentation site |
|---|---|
| [SPEC.md](SPEC.md) | [Architecture](https://docs.nanoclaw.dev/concepts/architecture) |
| [SECURITY.md](SECURITY.md) | [Security model](https://docs.nanoclaw.dev/concepts/security) |
| [REQUIREMENTS.md](REQUIREMENTS.md) | [Introduction](https://docs.nanoclaw.dev/introduction) |
| [skills-as-branches.md](skills-as-branches.md) | [Skills system](https://docs.nanoclaw.dev/integrations/skills-system) |
| [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md) | [Troubleshooting](https://docs.nanoclaw.dev/advanced/troubleshooting) |
| [docker-sandboxes.md](docker-sandboxes.md) | [Docker Sandboxes](https://docs.nanoclaw.dev/advanced/docker-sandboxes) |
| [APPLE-CONTAINER-NETWORKING.md](APPLE-CONTAINER-NETWORKING.md) | [Container runtime](https://docs.nanoclaw.dev/advanced/container-runtime) |

## Factotem fork-specific docs

These don't have upstream-NanoClaw equivalents — they cover the operator-facing surfaces (Doctor, dashboard, claw-setup wizard, release pipeline) that this fork adds.

| Doc | What it covers |
|---|---|
| [VISION.md](VISION.md) | Long-run trajectory: five pillars + non-goals. **Read before proposing a non-trivial change.** |
| [DEPLOYMENT_CONVENTIONS.md](DEPLOYMENT_CONVENTIONS.md) | **5-minute deployment briefing.** Two-repo setup, five-file version bump, tag namespace, what NOT to do. **Read before cutting a release.** |
| [RELEASES.md](RELEASES.md) | Maintainer runbook: asset inventory, version-bump checklist, upgrade-path table per version, manual downgrade procedure, CI secrets. The detailed reference for distribution mechanics. |
| [CHANGE_LOG.md](CHANGE_LOG.md) | Reverse-chronological entries. CI extracts release notes from here. |
| [OPERATIONS.md](OPERATIONS.md) | Operator-side runbook: startup, recovery, updating, troubleshooting. |
| [SETUP_WIZARD.md](SETUP_WIZARD.md) | claw-setup wizard step list + flag semantics. |
| [DASHBOARD_DESIGN.md](DASHBOARD_DESIGN.md) | Phase-4 dashboard design proposal (forward-looking). |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current-state Factotem architecture (extends upstream NanoClaw's spec). |
| [outbound-file-transfer.md](outbound-file-transfer.md), [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md) | Topic-specific deep dives. |
