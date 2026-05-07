//! Tauri command handlers (the IPC surface) + tray menu event router.
//!
//! M1.2 commands:
//!   - `probe_stack_now()` — force an immediate re-probe.
//!   - `get_last_status()` — read the cached last snapshot.
//!
//! M1.3 adds:
//!   - `start_repair(confirm)` — typed-confirm-gated sequential exec.
//!   - `get_recovery_manifest()` — load bundled recovery-steps.json so
//!     the React UI can render the steps before invoking start_repair.
//!
//! M1.4 adds:
//!   - `get_settings()` / `save_settings(settings)` — operator preferences.
//!   - `tail_log(lines)` — read the last N lines of nanoclaw.log.
//!   - `get_log_path()` — resolve the on-disk path of nanoclaw.log so
//!     the Logs window can show "no log yet" rather than misreporting.

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::manifest::{load_manifest, RecoveryManifest};
use crate::probe::{probe_stack, StackStatus};
use crate::repair::{run_repair, RepairResult};
use crate::settings::{self, Settings};

/// Shared snapshot — the latest probe result. Wrapped in a Mutex so the
/// probe scheduler can write while commands read. Clone is cheap (Arc).
#[derive(Clone)]
pub struct LastStatus(pub Arc<Mutex<Option<StackStatus>>>);

impl LastStatus {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

#[tauri::command]
pub async fn probe_stack_now(state: State<'_, LastStatus>) -> Result<StackStatus, String> {
    let status = probe_stack().await;
    *state.0.lock() = Some(status.clone());
    Ok(status)
}

#[tauri::command]
pub fn get_last_status(state: State<'_, LastStatus>) -> Result<Option<StackStatus>, String> {
    Ok(state.0.lock().clone())
}

#[tauri::command]
pub fn get_recovery_manifest() -> Result<RecoveryManifest, String> {
    load_manifest()
}

const REPAIR_CONFIRM_PHRASE: &str = "RESTART STACK";

/// Run the full Repair Stack sequence after the operator types the
/// confirmation phrase. The frontend gates the button on a local-state
/// match; this server-side check is defence in depth — the sequence
/// invokes `pkill`-class shell commands and must never fire on an
/// accidental click that bypassed the dialog.
#[tauri::command]
pub async fn start_repair(app: AppHandle, confirm: String) -> Result<RepairResult, String> {
    if confirm != REPAIR_CONFIRM_PHRASE {
        return Err(format!(
            "confirmation phrase must be exactly \"{}\"",
            REPAIR_CONFIRM_PHRASE
        ));
    }
    let manifest = load_manifest()?;
    let result = run_repair(app, manifest).await;
    Ok(result)
}

// ──────────────────────────────────────────────────────────────────────
// M1.4 — Settings + Logs commands.
// ──────────────────────────────────────────────────────────────────────

/// Shared settings cell — kept in app state so the probe loop and the
/// command handlers see a single source of truth. Updates from the
/// Settings window broadcast through this same cell.
#[derive(Clone)]
pub struct SettingsState(pub Arc<Mutex<Settings>>);

impl SettingsState {
    pub fn new(settings: Settings) -> Self {
        Self(Arc::new(Mutex::new(settings)))
    }
}

#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Result<Settings, String> {
    Ok(state.0.lock().clone())
}

/// Persist settings to disk and update the in-memory cell. Side effects
/// the operator can observe immediately:
///   - poll_interval_ms: the next probe tick honours the new value.
///   - launch_at_login: the autostart plugin registers/unregisters
///     `~/Library/LaunchAgents/com.factotem.doctor.plist`.
/// Notifications take effect on the next state transition.
#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    settings: Settings,
) -> Result<Settings, String> {
    settings::save(&settings)?;

    // Sync launch-at-login with the plugin's truth. Errors here are
    // surfaced but don't block save — the operator can retry or toggle
    // manually via System Settings → General → Login Items.
    if let Err(e) = sync_autostart(&app, settings.launch_at_login) {
        tracing::warn!(error = %e, "autostart sync failed");
    }

    *state.0.lock() = settings.clone();
    Ok(settings)
}

fn sync_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let is_enabled = manager.is_enabled().map_err(|e| format!("{}", e))?;
    if enabled && !is_enabled {
        manager.enable().map_err(|e| format!("{}", e))?;
        tracing::info!("autostart enabled");
    } else if !enabled && is_enabled {
        manager.disable().map_err(|e| format!("{}", e))?;
        tracing::info!("autostart disabled");
    }
    Ok(())
}

/// Resolve the on-disk path of nanoclaw.log. Tries:
///   1. `plutil -extract StandardOutPath raw -o - ~/Library/LaunchAgents/com.nanoclaw.plist`
///   2. `$HOME/Documents/NanoClaw/nanoclaw/logs/nanoclaw.log` (Don's default)
/// Returns None if neither exists yet (e.g., NanoClaw never installed).
fn resolve_nanoclaw_log_path() -> Option<PathBuf> {
    // Path 1 — read the launchd plist via plutil. plist may be binary or
    // XML; plutil handles both. `-extract <key> raw` prints the value
    // without quoting.
    if let Some(home) = std::env::var_os("HOME") {
        let plist = PathBuf::from(&home).join("Library/LaunchAgents/com.nanoclaw.plist");
        if plist.exists() {
            if let Ok(out) = std::process::Command::new("/usr/bin/plutil")
                .args([
                    "-extract",
                    "StandardOutPath",
                    "raw",
                    "-o",
                    "-",
                    plist.to_str().unwrap_or(""),
                ])
                .output()
            {
                if out.status.success() {
                    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !raw.is_empty() {
                        let p = PathBuf::from(raw);
                        if p.exists() {
                            return Some(p);
                        }
                    }
                }
            }
        }

        // Path 2 — known fallback.
        let fallback = PathBuf::from(&home)
            .join("Documents/NanoClaw/nanoclaw/logs/nanoclaw.log");
        if fallback.exists() {
            return Some(fallback);
        }
    }
    None
}

#[tauri::command]
pub fn get_log_path() -> Result<Option<String>, String> {
    Ok(resolve_nanoclaw_log_path().map(|p| p.display().to_string()))
}

/// Tail the last N lines of nanoclaw.log. `lines` is clamped to [1, 5000]
/// so the front-end doesn't accidentally request megabytes of text.
/// Returns Err with a brief reason when the log can't be located or read.
#[tauri::command]
pub fn tail_log(lines: usize) -> Result<String, String> {
    let path = resolve_nanoclaw_log_path()
        .ok_or_else(|| "nanoclaw.log not found (NanoClaw not installed?)".to_string())?;
    let n = lines.clamp(1, 5_000);

    // Use `tail -n N` rather than reading the whole file; logs can grow
    // to tens of MB during a long incident and the operator only ever
    // wants the recent slice.
    let out = std::process::Command::new("/usr/bin/tail")
        .args(["-n", &n.to_string(), path.to_str().unwrap_or("")])
        .output()
        .map_err(|e| format!("spawn tail: {}", e))?;

    if !out.status.success() {
        return Err(format!(
            "tail exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// ──────────────────────────────────────────────────────────────────────
// R.1 — Updater commands.
//
// Wraps tauri-plugin-updater so the React side can poll, prompt, and
// install updates. Two commands surface to the UI:
//   - check_for_updates() → returns Some(UpdateInfo) or None
//   - install_update_and_restart() → downloads + verifies + installs +
//     calls app.restart() (auto-relaunches the new version)
//
// The plugin's signature verification uses the ed25519 pubkey baked
// into tauri.conf.json plugins.updater.pubkey. CI signs each release's
// .tar.gz with the matching private key (kept out of the repo); a
// release with an invalid signature is rejected before install.
// ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| format!("{}", e))?;
    let current_version = app.package_info().version.to_string();
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo {
            version: update.version.clone(),
            current_version,
            date: update.date.map(|d| d.to_string()),
            body: update.body.clone(),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(format!("update check failed: {}", e)),
    }
}

#[tauri::command]
pub async fn install_update_and_restart(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| format!("{}", e))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("check: {}", e))?
        .ok_or_else(|| "no update available".to_string())?;

    // download_and_install streams bytes to a temp file, verifies the
    // ed25519 signature against tauri.conf.json's pubkey, then replaces
    // the running .app bundle. The two closures are progress callbacks;
    // we pipe them into tracing for now and surface progress to the UI
    // in R.3 once the operator-approved flow lands.
    update
        .download_and_install(
            |chunk_length, content_length| {
                tracing::debug!(chunk_length, content_length, "update downloading");
            },
            || {
                tracing::info!("update download finished — installing");
            },
        )
        .await
        .map_err(|e| format!("install: {}", e))?;

    tracing::info!("update installed — restarting");
    app.restart();
}

// ──────────────────────────────────────────────────────────────────────
// Tray menu event router.
// Connected in main.rs via TrayIconBuilder::on_menu_event.
// ──────────────────────────────────────────────────────────────────────

pub fn handle_menu_event(app: &AppHandle, event_id: &str) {
    use crate::tray::ids;
    match event_id {
        ids::OPEN_DASHBOARD => {
            open_url(app, "http://localhost:7842/");
        }
        ids::OPEN_RECOVERY => {
            open_recovery_panel(app);
        }
        ids::REPAIR_STACK => {
            open_or_focus_window(app, "repair", "?view=repair", "Repair Stack", 480.0, 720.0);
        }
        ids::SHOW_DETAILS => {
            open_or_focus_window(
                app,
                "diagnostics",
                "?view=diagnostics",
                "Diagnostic Details",
                560.0,
                720.0,
            );
        }
        ids::OPEN_SETTINGS => {
            open_or_focus_window(
                app,
                "settings",
                "?view=settings",
                "Doctor Settings",
                480.0,
                560.0,
            );
        }
        ids::OPEN_LOGS => {
            open_or_focus_window(app, "logs", "?view=logs", "NanoClaw Logs", 720.0, 560.0);
        }
        ids::QUIT => {
            app.exit(0);
        }
        _ => {
            // headline / detail / last_checked are non-interactive labels.
            tracing::debug!(event_id, "menu event for non-interactive item");
        }
    }
}

/// Open a Tauri WebView window (or focus an existing one). The label is
/// the window's stable id; the query string drives client-side routing
/// inside the React app.
fn open_or_focus_window(
    app: &AppHandle,
    label: &str,
    query: &str,
    title: &str,
    width: f64,
    height: f64,
) {
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return;
    }
    let url = WebviewUrl::App(format!("index.html{}", query).into());
    match WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .inner_size(width, height)
        .min_inner_size(420.0, 520.0)
        .resizable(true)
        .visible(true)
        .focused(true)
        .center()
        .build()
    {
        Ok(_) => tracing::info!(label, "opened window"),
        Err(e) => tracing::error!(error = %e, label, "failed to open window"),
    }
}

fn open_url(app: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        tracing::error!(error = %e, url, "failed to open url");
    }
}

fn open_recovery_panel(app: &AppHandle) {
    // The recovery panel was installed by `scripts/install-recovery.sh`
    // (Phase 0). On macOS the file lives at:
    //   ~/Library/Application Support/Factotem/recovery.html
    // On other OSes the install path varies; for now we only support
    // the macOS canonical location.
    if let Some(home) = std::env::var_os("HOME") {
        let mut path = std::path::PathBuf::from(home);
        path.push("Library");
        path.push("Application Support");
        path.push("Factotem");
        path.push("recovery.html");

        if path.exists() {
            // Use `open` via the shell plugin to honor the operator's
            // default browser preference.
            let url = format!("file://{}", path.display());
            open_url(app, &url);
        } else {
            tracing::warn!(
                path = %path.display(),
                "recovery panel not installed — operator can run scripts/install-recovery.sh"
            );
            // Fall back to the github runbook so the click still leads
            // somewhere useful.
            open_url(
                app,
                "https://github.com/donkruger/factotem/blob/main/docs/OPERATIONS.md#recovery",
            );
        }
    }
}
