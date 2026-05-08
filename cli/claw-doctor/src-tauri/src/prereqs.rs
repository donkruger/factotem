//! Pre-flight prerequisite probes for the Welcome window.
//!
//! R1 from the 2026-05-08 setup-journey UX audit
//! (assessments/2026-05-08-setup-journey-ux.md). The Welcome window
//! used to render static prerequisite copy ("you'll need git and
//! Node 20+") and immediately delegate to Terminal — failures landed
//! 30 seconds later with `command not found: npm` and the operator
//! had no way back into the Doctor's flow.
//!
//! These commands let the Welcome window probe git, node, docker,
//! and tailscale before exposing the "Open Terminal with this
//! command" CTA. Failures stay inside the Doctor with actionable
//! per-item install hints, and the React side can gate the CTA on
//! the green-light state.
//!
//! Every probe is bounded by a short timeout so a hung subprocess
//! never freezes the welcome window.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use tokio::time::timeout;

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const NODE_MIN_MAJOR: u32 = 20;
const DOCKER_APP_PATH: &str = "/Applications/Docker.app";
const DOCKER_LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
const DOCKER_LAUNCH_POLL_MS: u64 = 2_000;

/// One prerequisite's snapshot. The React side renders one row per
/// result and decides whether to gate the CTA.
#[derive(Debug, Clone, Serialize)]
pub struct PrereqResult {
    /// Stable identifier — "git", "node", "docker", "tailscale".
    pub name: String,
    /// True iff the binary / app is present on disk.
    pub installed: bool,
    /// True iff `installed` AND the version / state meets the wizard's
    /// requirement (e.g. node ≥ 20, docker daemon reachable).
    pub ok: bool,
    /// Human-readable single-line status — what to render next to the
    /// row. "node v22.5.1 (≥ v20)", "Docker installed but daemon stopped",
    /// "Tailscale not installed", etc.
    pub detail: String,
    /// Where to send the operator if they need to install. Always
    /// populated so the React side can render a fallback link even
    /// when the probe doesn't suggest a more specific action.
    pub install_url: String,
    /// Optional one-click action the Doctor can perform on the
    /// operator's behalf. Today only `LaunchDockerApp` exists, for
    /// when Docker.app is on disk but the daemon isn't running.
    pub fix_action: Option<FixAction>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum FixAction {
    /// Open `/Applications/Docker.app` and wait for the daemon to come
    /// up. The matching command is `launch_docker_and_wait`.
    LaunchDockerApp,
}

// ──────────────────────────────────────────────────────────────────────
// Public Tauri commands.
// ──────────────────────────────────────────────────────────────────────

/// Run all four probes in parallel and return them as a list. The React
/// side calls this once on Welcome window mount, again whenever the
/// operator clicks "Recheck", and again after `launch_docker_and_wait`
/// completes.
#[tauri::command]
pub async fn check_all_prereqs() -> Result<Vec<PrereqResult>, String> {
    let (git, node, docker, tailscale) = tokio::join!(
        check_git_inner(),
        check_node_inner(),
        check_docker_inner(),
        check_tailscale_inner(),
    );
    Ok(vec![git, node, docker, tailscale])
}

/// Open `/Applications/Docker.app` and poll `docker info` every
/// `DOCKER_LAUNCH_POLL_MS` for up to `DOCKER_LAUNCH_TIMEOUT`. Returns
/// the final docker probe result (whether the daemon came up or not).
/// Mirrors the wizard's `probeDockerWithAutoLaunch` in
/// `cli/claw-setup/src/steps/01-check-prereqs.ts` (R3 from the same
/// audit) — same 60s wait, same 2s poll cadence.
#[tauri::command]
pub async fn launch_docker_and_wait() -> Result<PrereqResult, String> {
    if !cfg!(target_os = "macos") {
        return Err("launch_docker_and_wait is macOS-only".to_string());
    }
    if !Path::new(DOCKER_APP_PATH).exists() {
        return Err(format!("{} not found — install Docker Desktop first", DOCKER_APP_PATH));
    }

    // Best-effort launch — `open` is fire-and-forget on macOS.
    let _ = Command::new("/usr/bin/open")
        .args(["-a", "Docker"])
        .status()
        .await
        .map_err(|e| format!("spawn open: {}", e))?;

    tracing::info!("launched Docker Desktop; waiting up to 60s for daemon");

    let started = tokio::time::Instant::now();
    while started.elapsed() < DOCKER_LAUNCH_TIMEOUT {
        tokio::time::sleep(Duration::from_millis(DOCKER_LAUNCH_POLL_MS)).await;
        if probe_docker_info().await.is_ok() {
            let elapsed_secs = started.elapsed().as_secs();
            tracing::info!(elapsed_secs, "docker daemon came up");
            return Ok(PrereqResult {
                name: "docker".to_string(),
                installed: true,
                ok: true,
                detail: format!("Docker daemon came up in {}s after launch", elapsed_secs),
                install_url: docker_install_url().to_string(),
                fix_action: None,
            });
        }
    }

    tracing::warn!("docker daemon didn't come up within 60s after launch");
    Ok(PrereqResult {
        name: "docker".to_string(),
        installed: true,
        ok: false,
        detail:
            "Docker Desktop launched but the daemon didn't come up within 60s. Open Docker Desktop manually and click Recheck."
                .to_string(),
        install_url: docker_install_url().to_string(),
        fix_action: Some(FixAction::LaunchDockerApp),
    })
}

// ──────────────────────────────────────────────────────────────────────
// Per-prerequisite probes — internal.
// ──────────────────────────────────────────────────────────────────────

async fn check_git_inner() -> PrereqResult {
    let install_url = "https://developer.apple.com/xcode/resources/".to_string();
    match run_with_timeout("git", &["--version"]).await {
        Ok(stdout) => {
            // Output shape: "git version 2.43.0 (Apple Git-149)".
            let version = stdout
                .split_whitespace()
                .nth(2)
                .unwrap_or("(unknown)")
                .to_string();
            PrereqResult {
                name: "git".to_string(),
                installed: true,
                ok: true,
                detail: format!("git {}", version),
                install_url,
                fix_action: None,
            }
        }
        Err(_) => PrereqResult {
            name: "git".to_string(),
            installed: false,
            ok: false,
            detail:
                "git not found. On macOS, running `git --version` in Terminal triggers the Xcode Command Line Tools installer."
                    .to_string(),
            install_url,
            fix_action: None,
        },
    }
}

async fn check_node_inner() -> PrereqResult {
    let install_url = "https://nodejs.org/en/download".to_string();
    match run_with_timeout("node", &["--version"]).await {
        Ok(stdout) => {
            // Output shape: "v22.5.1\n".
            let trimmed = stdout.trim();
            let major = trimmed
                .strip_prefix('v')
                .and_then(|s| s.split('.').next())
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0);
            let ok = major >= NODE_MIN_MAJOR;
            let detail = if ok {
                format!("node {} (≥ v{})", trimmed, NODE_MIN_MAJOR)
            } else {
                format!(
                    "node {} is too old; need ≥ v{}. Install from nodejs.org.",
                    trimmed, NODE_MIN_MAJOR
                )
            };
            PrereqResult {
                name: "node".to_string(),
                installed: true,
                ok,
                detail,
                install_url,
                fix_action: None,
            }
        }
        Err(_) => PrereqResult {
            name: "node".to_string(),
            installed: false,
            ok: false,
            detail: format!(
                "node not found. Install Node.js {}+ from nodejs.org (LTS .pkg installer).",
                NODE_MIN_MAJOR
            ),
            install_url,
            fix_action: None,
        },
    }
}

async fn check_docker_inner() -> PrereqResult {
    let install_url = docker_install_url().to_string();
    match probe_docker_info().await {
        Ok(_) => PrereqResult {
            name: "docker".to_string(),
            installed: true,
            ok: true,
            detail: "Docker daemon reachable".to_string(),
            install_url,
            fix_action: None,
        },
        Err(_) => {
            // `docker info` failed — check whether Docker.app is on disk.
            // If yes, the Doctor can offer to launch it (FixAction).
            // If no, classify as not installed.
            let app_present = Path::new(DOCKER_APP_PATH).exists();
            if app_present {
                PrereqResult {
                    name: "docker".to_string(),
                    installed: true,
                    ok: false,
                    detail: "Docker is installed but the daemon isn't running. Click Launch Docker.".to_string(),
                    install_url,
                    fix_action: Some(FixAction::LaunchDockerApp),
                }
            } else {
                PrereqResult {
                    name: "docker".to_string(),
                    installed: false,
                    ok: false,
                    detail: "Docker Desktop not installed. Install from docker.com.".to_string(),
                    install_url,
                    fix_action: None,
                }
            }
        }
    }
}

async fn check_tailscale_inner() -> PrereqResult {
    let install_url = "https://tailscale.com/download".to_string();
    match run_with_timeout("tailscale", &["status"]).await {
        Ok(_) => PrereqResult {
            name: "tailscale".to_string(),
            installed: true,
            ok: true,
            detail: "Tailscale installed and reachable".to_string(),
            install_url,
            fix_action: None,
        },
        Err(_) => {
            // We can't easily distinguish "installed but not running"
            // from "not installed" without parsing brew / pkg state.
            // Surface a single actionable message and link.
            PrereqResult {
                name: "tailscale".to_string(),
                installed: false,
                ok: false,
                detail:
                    "Tailscale not detected. Install from tailscale.com (free for personal use)."
                        .to_string(),
                install_url,
                fix_action: None,
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────
// Helpers.
// ──────────────────────────────────────────────────────────────────────

fn docker_install_url() -> &'static str {
    "https://www.docker.com/products/docker-desktop/"
}

async fn probe_docker_info() -> Result<String, String> {
    run_with_timeout("docker", &["info"]).await
}

/// Run `cmd args...` with `PROBE_TIMEOUT`. Returns stdout on exit-zero,
/// otherwise an error string suitable for logging (we never surface
/// these to the operator directly — the per-probe `detail` strings do
/// that with hand-tuned copy).
async fn run_with_timeout(cmd: &str, args: &[&str]) -> Result<String, String> {
    let fut = Command::new(cmd).args(args).output();
    let output = timeout(PROBE_TIMEOUT, fut)
        .await
        .map_err(|_| format!("{} timed out after {:?}", cmd, PROBE_TIMEOUT))?
        .map_err(|e| format!("spawn {}: {}", cmd, e))?;
    if !output.status.success() {
        return Err(format!(
            "{} exited {}: {}",
            cmd,
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
