//! Sequential Repair Stack executor.
//!
//! Reads the recovery-steps manifest (bundled at build time) and runs each
//! step's `command` via `bash -c`. After each step's primary command, an
//! optional `verify` block polls a verification command until it succeeds
//! or the `max_wait_ms` window elapses. Required steps abort the chain on
//! failure; non-required steps are skipped.
//!
//! The frontend subscribes to `repair-progress` Tauri events to render
//! live state per step. The synchronous `run_repair` return value is the
//! authoritative final result; events are advisory.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::process::Command;
use tokio::time::timeout;

use crate::manifest::{RecoveryManifest, RecoveryStep, VerifyStep};

// ──────────────────────────────────────────────────────────────────────
// Public types — emitted to the React frontend.
// ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StepState {
    Pending,
    Running,
    Done { duration_ms: u64 },
    Failed { detail: String, duration_ms: u64 },
    Skipped { detail: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepProgress {
    pub id: String,
    pub title: String,
    pub state: StepState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OverallRepairState {
    NotStarted,
    Running,
    Completed { duration_ms: u64 },
    Failed { failed_step_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairResult {
    pub steps: Vec<StepProgress>,
    pub overall: OverallRepairState,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub finished_at: chrono::DateTime<chrono::Utc>,
}

/// Per-step events emitted to the frontend over the `repair-progress`
/// event channel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RepairEvent {
    Started,
    StepStarted {
        step_id: String,
    },
    StepDone {
        step_id: String,
        duration_ms: u64,
    },
    StepFailed {
        step_id: String,
        detail: String,
        duration_ms: u64,
    },
    StepSkipped {
        step_id: String,
        detail: String,
    },
    Completed {
        duration_ms: u64,
    },
    Failed {
        failed_step_id: String,
    },
}

// ──────────────────────────────────────────────────────────────────────
// Executor.
// ──────────────────────────────────────────────────────────────────────

const REPAIR_EVENT: &str = "repair-progress";

/// Run every step in the manifest sequentially. Emits `repair-progress`
/// events at every state transition. Returns the final state synchronously
/// so the caller can also observe completion via the command return value.
pub async fn run_repair(app: AppHandle, manifest: RecoveryManifest) -> RepairResult {
    let started = Instant::now();
    let started_at = chrono::Utc::now();

    // Initialise progress with everything pending.
    let mut steps: Vec<StepProgress> = manifest
        .steps
        .iter()
        .map(|s| StepProgress {
            id: s.id.clone(),
            title: s.title.clone(),
            state: StepState::Pending,
        })
        .collect();

    let _ = app.emit(REPAIR_EVENT, RepairEvent::Started);

    for (i, step) in manifest.steps.iter().enumerate() {
        run_step(&app, &mut steps, i, step).await;

        // If the step failed and was required, stop the chain.
        if matches!(steps[i].state, StepState::Failed { .. }) && step.required {
            // Total elapsed isn't carried in the failure result shape (the
            // failed_step_id + per-step duration_ms is sufficient for the
            // UI). Discard but keep the comment so M1.4 can wire a header
            // total-duration display if ever wanted.
            let _ = started.elapsed();
            let failed_id = step.id.clone();
            let _ = app.emit(
                REPAIR_EVENT,
                RepairEvent::Failed {
                    failed_step_id: failed_id.clone(),
                },
            );
            return RepairResult {
                steps,
                overall: OverallRepairState::Failed {
                    failed_step_id: failed_id,
                },
                started_at,
                finished_at: chrono::Utc::now(),
            };
        }
    }

    let total_ms = started.elapsed().as_millis() as u64;
    let _ = app.emit(
        REPAIR_EVENT,
        RepairEvent::Completed {
            duration_ms: total_ms,
        },
    );
    RepairResult {
        steps,
        overall: OverallRepairState::Completed {
            duration_ms: total_ms,
        },
        started_at,
        finished_at: chrono::Utc::now(),
    }
}

async fn run_step(
    app: &AppHandle,
    progress: &mut [StepProgress],
    i: usize,
    step: &RecoveryStep,
) {
    let started = Instant::now();
    progress[i].state = StepState::Running;
    let _ = app.emit(
        REPAIR_EVENT,
        RepairEvent::StepStarted {
            step_id: step.id.clone(),
        },
    );

    // 1. Run the primary command.
    if let Err(e) = run_shell_bash(&step.command, Duration::from_millis(step.timeout_ms)).await {
        let duration_ms = started.elapsed().as_millis() as u64;
        if step.required {
            progress[i].state = StepState::Failed {
                detail: e.clone(),
                duration_ms,
            };
            let _ = app.emit(
                REPAIR_EVENT,
                RepairEvent::StepFailed {
                    step_id: step.id.clone(),
                    detail: e,
                    duration_ms,
                },
            );
        } else {
            progress[i].state = StepState::Skipped { detail: e.clone() };
            let _ = app.emit(
                REPAIR_EVENT,
                RepairEvent::StepSkipped {
                    step_id: step.id.clone(),
                    detail: e,
                },
            );
        }
        return;
    }

    // 2. Verify (if the step has a verify block).
    if let Some(verify) = &step.verify {
        if let Err(e) = verify_with_polling(verify).await {
            let duration_ms = started.elapsed().as_millis() as u64;
            if step.required {
                progress[i].state = StepState::Failed {
                    detail: e.clone(),
                    duration_ms,
                };
                let _ = app.emit(
                    REPAIR_EVENT,
                    RepairEvent::StepFailed {
                        step_id: step.id.clone(),
                        detail: e,
                        duration_ms,
                    },
                );
            } else {
                progress[i].state = StepState::Skipped { detail: e.clone() };
                let _ = app.emit(
                    REPAIR_EVENT,
                    RepairEvent::StepSkipped {
                        step_id: step.id.clone(),
                        detail: e,
                    },
                );
            }
            return;
        }
    }

    // Step complete.
    let duration_ms = started.elapsed().as_millis() as u64;
    progress[i].state = StepState::Done { duration_ms };
    let _ = app.emit(
        REPAIR_EVENT,
        RepairEvent::StepDone {
            step_id: step.id.clone(),
            duration_ms,
        },
    );
}

/// Run a shell command via `bash -c "<cmd>"` with a hard timeout.
/// Returns Ok on exit 0, Err with a brief detail otherwise.
async fn run_shell_bash(cmd: &str, dur: Duration) -> Result<(), String> {
    match timeout(dur, Command::new("bash").args(["-c", cmd]).output()).await {
        Ok(Ok(output)) => {
            if output.status.success() {
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                let detail = if !stderr.trim().is_empty() {
                    stderr.trim().to_string()
                } else if !stdout.trim().is_empty() {
                    stdout.trim().to_string()
                } else {
                    format!("exit {}", output.status)
                };
                // Cap the detail length so it fits in the React UI without
                // forcing horizontal scroll.
                Err(truncate(detail, 240))
            }
        }
        Ok(Err(e)) => Err(format!("spawn failed: {}", e)),
        Err(_) => Err(format!("timed out after {}ms", dur.as_millis())),
    }
}

/// Repeatedly run the verify command until success, with a hard wall-clock
/// budget. Used for steps like Docker that take 30+s to fully start —
/// the primary command (`open -a Docker`) returns instantly, but the
/// verify (`docker info`) needs to keep polling until the daemon answers.
async fn verify_with_polling(verify: &VerifyStep) -> Result<(), String> {
    let started = Instant::now();
    let max_wait = Duration::from_millis(verify.max_wait_ms);
    let poll = Duration::from_millis(verify.poll_ms);
    let mut last_err: String;

    loop {
        match run_shell_bash(&verify.command, Duration::from_millis(verify.timeout_ms)).await {
            Ok(_) => return Ok(()),
            Err(e) => {
                last_err = e;
                if started.elapsed() >= max_wait {
                    return Err(format!(
                        "verify timed out after {}s (last error: {})",
                        max_wait.as_secs(),
                        last_err
                    ));
                }
                tokio::time::sleep(poll).await;
            }
        }
    }
}

fn truncate(s: String, n: usize) -> String {
    if s.len() <= n {
        s
    } else {
        let mut t = s.chars().take(n - 1).collect::<String>();
        t.push('…');
        t
    }
}
