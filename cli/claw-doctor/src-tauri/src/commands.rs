//! Tauri command handlers (the IPC surface) + tray menu event router.
//!
//! The set of commands is intentionally small in M1.2:
//!   - `probe_stack_now()` — force an immediate re-probe (used by Show
//!      Details window in M1.3 and Settings refresh-now button in M1.4).
//!   - `get_last_status()` — read the cached last snapshot.
//!
//! M1.3 adds `repair_stack()`. M1.4 adds settings persistence. Both
//! land here.

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, State};

use crate::probe::{probe_stack, StackStatus};

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
        ids::SHOW_DETAILS => {
            // M1.2 fallback: no real window yet — just log.
            // M1.3 wires the diagnostic window here.
            tracing::info!("Show details requested (M1.3 will surface this in a window)");
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
