//! Stack health probes for the Factotem Doctor menu-bar app.
//!
//! Runs every 5 seconds (configurable) and produces a [`StackStatus`]
//! snapshot. Multi-instance detection is part of the snapshot, not a
//! separate layer: the probe surfaces every NanoClaw process, every
//! launchd label matching `com.nanoclaw*`, and the owner of port 7842.
//!
//! All probes are bounded by `tokio::time::timeout` so the tray icon
//! never stalls on a hung subprocess.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::time::timeout;

/// Default port the dashboard listens on. Matches `NANOCLAW_HTTP_PORT`
/// in the orchestrator's `src/config.ts`.
const DASHBOARD_PORT: u16 = 7842;

/// OneCLI gateway loopback URL.
const ONECLI_URL: &str = "http://127.0.0.1:10254/";

/// NanoClaw HTTP health endpoint.
const HEALTH_URL: &str = "http://localhost:7842/health";

/// Timeout for individual shell-based probes.
const SHELL_TIMEOUT: Duration = Duration::from_secs(3);

/// Timeout for HTTP probes.
const HTTP_TIMEOUT: Duration = Duration::from_secs(2);

// ──────────────────────────────────────────────────────────────────────
// Public types — the snapshot the tray + windows render.
// ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StackStatus {
    pub docker: ProbeResult,
    pub onecli: ProbeResult,
    pub nanoclaw_processes: Vec<NanoClawProc>,
    pub nanoclaw_launchd: Vec<LaunchdJob>,
    pub port_7842_owner: Option<PortOwner>,
    pub nanoclaw_http: ProbeResult,
    pub overall: OverallStatus,
    pub last_probed_at: DateTime<Utc>,
    /// Human-readable headline for the tray menu's first row.
    pub headline: String,
    /// Optional secondary line — populated when overall is amber/red
    /// to explain the multi-instance / port-conflict situation.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub detail: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NanoClawProc {
    pub pid: u32,
    pub parent_pid: u32,
    pub command: String,
    /// True when parent_pid == 1 (launchd-spawned).
    pub launchd_spawned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchdJob {
    pub label: String,
    pub pid: Option<u32>,
    pub last_exit_status: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortOwner {
    pub pid: u32,
    pub command: String,
    /// True when this PID also appears in the NanoClaw process list.
    pub is_nanoclaw: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OverallStatus {
    /// Stack alive and healthy.
    Green,
    /// Stack reachable but in a degraded / multi-instance / slow state.
    Amber,
    /// Stack offline — services were configured to run but aren't.
    Red,
    /// Initial state before the first probe completes.
    Grey,
    /// Stack has never been installed on this machine. Distinguishes
    /// "I tried to set up the orchestrator and it crashed" (Red) from
    /// "I'm a fresh-install operator who downloaded the Doctor and
    /// hasn't run claw-setup yet" (NotInstalled). UX consequences:
    /// menu items relabel ("Set up NanoClaw…" instead of "Repair Stack"),
    /// destructive actions are gated, dashboard menu item disables.
    NotInstalled,
}

// ──────────────────────────────────────────────────────────────────────
// The probe entry point.
// ──────────────────────────────────────────────────────────────────────

/// Run every probe in parallel and synthesize a single [`StackStatus`].
pub async fn probe_stack() -> StackStatus {
    let now = Utc::now();
    let (docker, onecli, processes, launchd_jobs, port_owner_raw, http) = tokio::join!(
        probe_docker(),
        probe_onecli(),
        probe_nanoclaw_processes(),
        probe_launchd_labels(),
        probe_port_7842(),
        probe_nanoclaw_http(),
    );

    // Cross-reference port owner against the NanoClaw process list to
    // decide whether the port is held by NanoClaw or a foreign process.
    let port_7842_owner = port_owner_raw.map(|mut owner| {
        owner.is_nanoclaw = processes.iter().any(|p| p.pid == owner.pid);
        owner
    });

    let (overall, headline, detail) =
        synthesize_overall(&docker, &onecli, &processes, &launchd_jobs, &port_7842_owner, &http);

    StackStatus {
        docker,
        onecli,
        nanoclaw_processes: processes,
        nanoclaw_launchd: launchd_jobs,
        port_7842_owner,
        nanoclaw_http: http,
        overall,
        last_probed_at: now,
        headline,
        detail,
    }
}

// ──────────────────────────────────────────────────────────────────────
// Synthesis — turn raw probe results into the headline state.
// This is where the multi-instance logic lives.
// ──────────────────────────────────────────────────────────────────────

fn synthesize_overall(
    docker: &ProbeResult,
    onecli: &ProbeResult,
    processes: &[NanoClawProc],
    launchd_jobs: &[LaunchdJob],
    port_owner: &Option<PortOwner>,
    http: &ProbeResult,
) -> (OverallStatus, String, Option<String>) {
    // "Stack not installed" — distinguishes a fresh-install operator
    // (Doctor downloaded but no claw-setup run yet) from a configured
    // operator whose stack happens to be down. Detected when EVERY
    // NanoClaw indicator is absent: zero orchestrator processes, zero
    // launchd labels matching com.nanoclaw* (excluding the OAuth-refresh
    // watcher which can persist past an uninstall), no owner of port
    // 7842. Independent of Docker / OneCLI status — those tools may
    // already be installed on the operator's machine for other reasons.
    let no_processes = processes.is_empty();
    let no_orchestrator_labels = launchd_jobs
        .iter()
        .all(|j| j.label.starts_with("com.nanoclaw.oauth-refresh"));
    let no_port_owner = port_owner.is_none();
    if no_processes && no_orchestrator_labels && no_port_owner {
        return (
            OverallStatus::NotInstalled,
            "NanoClaw not installed".to_string(),
            Some(
                "Run `npx claw-setup` in your terminal to set up the orchestrator."
                    .to_string(),
            ),
        );
    }

    // Red conditions, evaluated in priority order.

    // 1. Foreign process holds port 7842 — NanoClaw can't bind.
    if let Some(owner) = port_owner {
        if !owner.is_nanoclaw {
            return (
                OverallStatus::Red,
                format!(
                    "Port {} held by a non-NanoClaw process",
                    DASHBOARD_PORT
                ),
                Some(format!(
                    "PID {} ({}) owns the dashboard port. NanoClaw cannot start until it's freed.",
                    owner.pid, owner.command
                )),
            );
        }
    }

    // 2. Stack genuinely offline — Docker or OneCLI down + nothing on port + no NanoClaw process.
    if !docker.ok && processes.is_empty() && port_owner.is_none() {
        return (
            OverallStatus::Red,
            "Stack offline".to_string(),
            Some("Docker, OneCLI, and NanoClaw all down. Click Repair Stack to bring them up.".to_string()),
        );
    }

    if !docker.ok {
        return (
            OverallStatus::Red,
            "Docker engine unreachable".to_string(),
            Some(
                docker
                    .detail
                    .clone()
                    .unwrap_or_else(|| "`docker info` failed".to_string()),
            ),
        );
    }

    if !onecli.ok {
        return (
            OverallStatus::Red,
            "OneCLI gateway unreachable".to_string(),
            Some(
                onecli
                    .detail
                    .clone()
                    .unwrap_or_else(|| "127.0.0.1:10254 not responding".to_string()),
            ),
        );
    }

    if !http.ok {
        // NanoClaw HTTP unreachable. Could be: process crashed, server
        // failed to bind, or process is up but /health is broken.
        if processes.is_empty() {
            return (
                OverallStatus::Red,
                "NanoClaw not running".to_string(),
                Some("Docker + OneCLI healthy, but no NanoClaw process detected.".to_string()),
            );
        }
        return (
            OverallStatus::Red,
            "NanoClaw HTTP unreachable".to_string(),
            Some(format!(
                "{} NanoClaw process(es) detected, but :{} is not bound or /health is broken.",
                processes.len(),
                DASHBOARD_PORT
            )),
        );
    }

    // Green / amber from here. Everything responsive at minimum.

    // Filter launchd jobs to "real" NanoClaw orchestrators — exclude the
    // OAuth refresh watcher, which shares the namespace but isn't an
    // orchestrator instance.
    let orchestrator_labels: Vec<&LaunchdJob> = launchd_jobs
        .iter()
        .filter(|j| !j.label.starts_with("com.nanoclaw.oauth-refresh"))
        .collect();

    // Multi-instance detection:
    let multiple_processes = processes.len() > 1;
    let multiple_orchestrator_labels = orchestrator_labels.len() > 1;
    let dev_mode_running = processes.iter().any(|p| !p.launchd_spawned);

    if multiple_orchestrator_labels {
        let labels: Vec<String> =
            orchestrator_labels.iter().map(|j| j.label.clone()).collect();
        return (
            OverallStatus::Amber,
            format!("{} NanoClaw services loaded", orchestrator_labels.len()),
            Some(format!(
                "Loaded labels: {}. Only one is bound to :{}; the others may be stale installs.",
                labels.join(", "),
                DASHBOARD_PORT
            )),
        );
    }

    if multiple_processes {
        return (
            OverallStatus::Amber,
            format!("{} NanoClaw processes detected", processes.len()),
            Some(if dev_mode_running {
                "A dev-mode instance is running alongside the launchd service. They share state files (SQLite, store/auth) — heads up.".to_string()
            } else {
                "Multiple NanoClaw processes match. Check `pgrep -fla \"dist/index.js\"` and confirm intentional.".to_string()
            }),
        );
    }

    // Slow probes warrant amber — something is fragile.
    let probes = [docker, onecli, http];
    if probes.iter().any(|p| p.duration_ms > 1000) {
        return (
            OverallStatus::Amber,
            "Stack slow but reachable".to_string(),
            Some("At least one probe took > 1s. Check resource pressure (Docker stats, host CPU).".to_string()),
        );
    }

    // Green path.
    let pid_str = processes
        .first()
        .map(|p| p.pid.to_string())
        .unwrap_or_else(|| "?".to_string());
    (
        OverallStatus::Green,
        format!("Factotem stack is healthy"),
        Some(format!(
            "NanoClaw PID {} bound to :{}; Docker {}; OneCLI {}.",
            pid_str,
            DASHBOARD_PORT,
            if docker.ok { "ok" } else { "down" },
            if onecli.ok { "ok" } else { "down" },
        )),
    )
}

// ──────────────────────────────────────────────────────────────────────
// Individual probe implementations.
// ──────────────────────────────────────────────────────────────────────

async fn probe_docker() -> ProbeResult {
    let started = std::time::Instant::now();
    match timeout(SHELL_TIMEOUT, run_shell("docker", &["info"])).await {
        Ok(Ok(_)) => ProbeResult {
            ok: true,
            detail: None,
            duration_ms: started.elapsed().as_millis() as u64,
        },
        Ok(Err(e)) => ProbeResult {
            ok: false,
            detail: Some(format!("docker info failed: {}", e)),
            duration_ms: started.elapsed().as_millis() as u64,
        },
        Err(_) => ProbeResult {
            ok: false,
            detail: Some("docker info timed out (Docker likely paused or wedged)".to_string()),
            duration_ms: started.elapsed().as_millis() as u64,
        },
    }
}

async fn probe_onecli() -> ProbeResult {
    probe_http(ONECLI_URL).await
}

async fn probe_nanoclaw_http() -> ProbeResult {
    probe_http(HEALTH_URL).await
}

async fn probe_http(url: &str) -> ProbeResult {
    let started = std::time::Instant::now();
    let client = match reqwest::Client::builder().timeout(HTTP_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            return ProbeResult {
                ok: false,
                detail: Some(format!("http client init: {}", e)),
                duration_ms: started.elapsed().as_millis() as u64,
            }
        }
    };
    match client.get(url).send().await {
        Ok(resp) => {
            // Any < 500 is "reachable". 401 from OneCLI = healthy auth gate.
            let ok = resp.status().as_u16() < 500;
            ProbeResult {
                ok,
                detail: if ok {
                    None
                } else {
                    Some(format!("HTTP {}", resp.status()))
                },
                duration_ms: started.elapsed().as_millis() as u64,
            }
        }
        Err(e) => ProbeResult {
            ok: false,
            detail: Some(format!("{}", e)),
            duration_ms: started.elapsed().as_millis() as u64,
        },
    }
}

/// Find every NanoClaw orchestrator process via `pgrep -fla "dist/index.js"`.
/// The `-l` flag includes the command line; `-a` adds the PID. We then
/// look up each PID's parent via `ps -o ppid=`.
async fn probe_nanoclaw_processes() -> Vec<NanoClawProc> {
    let raw = match timeout(SHELL_TIMEOUT, run_shell("pgrep", &["-fla", "dist/index.js"])).await
    {
        Ok(Ok(out)) => out,
        _ => return Vec::new(),
    };

    let mut procs = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // `pgrep -la` output: "<pid> <command line>"
        let mut parts = line.splitn(2, char::is_whitespace);
        let pid: u32 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        let command = parts.next().unwrap_or("").trim().to_string();

        // Filter out the `pgrep` invocation itself if it shows up
        // (rare on macOS but defensive).
        if command.contains("pgrep") {
            continue;
        }

        let parent_pid = lookup_parent_pid(pid).await.unwrap_or(0);
        procs.push(NanoClawProc {
            pid,
            parent_pid,
            command,
            launchd_spawned: parent_pid == 1,
        });
    }
    procs
}

async fn lookup_parent_pid(pid: u32) -> Option<u32> {
    let out = run_shell("ps", &["-o", "ppid=", "-p", &pid.to_string()])
        .await
        .ok()?;
    out.trim().parse().ok()
}

/// Find every launchd label matching `com.nanoclaw*` via `launchctl list`.
/// Output format is tab/space-separated: `<pid|->  <last_exit>  <label>`.
async fn probe_launchd_labels() -> Vec<LaunchdJob> {
    let raw = match timeout(SHELL_TIMEOUT, run_shell("launchctl", &["list"])).await {
        Ok(Ok(out)) => out,
        _ => return Vec::new(),
    };

    let mut jobs = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if !line.contains("com.nanoclaw") {
            continue;
        }
        let mut cols = line.split_whitespace();
        let pid_col = cols.next();
        let exit_col = cols.next();
        let label = cols.next();

        let label = match label {
            Some(l) if l.starts_with("com.nanoclaw") => l.to_string(),
            _ => continue,
        };

        let pid = pid_col.and_then(|s| s.parse::<u32>().ok());
        let last_exit_status = exit_col.and_then(|s| s.parse::<i32>().ok());

        jobs.push(LaunchdJob {
            label,
            pid,
            last_exit_status,
        });
    }
    jobs
}

/// Find what owns TCP :7842 via `lsof -nP -iTCP:7842 -sTCP:LISTEN -F pcL`.
/// Output is one field per line, prefixed with the field type:
/// `p<pid>`, `c<command>`, `L<login>`, etc.
async fn probe_port_7842() -> Option<PortOwner> {
    let port_arg = format!("-iTCP:{}", DASHBOARD_PORT);
    let raw = match timeout(
        SHELL_TIMEOUT,
        run_shell(
            "lsof",
            &["-nP", &port_arg, "-sTCP:LISTEN", "-F", "pcL"],
        ),
    )
    .await
    {
        Ok(Ok(out)) => out,
        _ => return None,
    };

    let mut pid: Option<u32> = None;
    let mut command: Option<String> = None;
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            pid = rest.trim().parse().ok();
        } else if let Some(rest) = line.strip_prefix('c') {
            command = Some(rest.trim().to_string());
        }
    }
    pid.map(|pid| PortOwner {
        pid,
        command: command.unwrap_or_else(|| "<unknown>".to_string()),
        is_nanoclaw: false, // filled in by probe_stack() after process scan
    })
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/// Run a shell command and return stdout as a String. Returns Err on
/// non-zero exit (which is sometimes informative — see Docker, where
/// `docker info` returns 1 when the daemon is down).
async fn run_shell(cmd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(cmd)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("spawn {}: {}", cmd, e))?;
    if !output.status.success() {
        return Err(format!(
            "{} exited with {}: {}",
            cmd,
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
