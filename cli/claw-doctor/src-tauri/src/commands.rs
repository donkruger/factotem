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
//! M1.4 will add settings persistence.

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::manifest::{load_manifest, RecoveryManifest};
use crate::probe::{probe_stack, StackStatus};
use crate::repair::{run_repair, RepairResult};

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
                "https://github.com/donkruger/benclaw/blob/main/docs/OPERATIONS.md#recovery",
            );
        }
    }
}
