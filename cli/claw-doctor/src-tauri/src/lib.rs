// Prevents additional console window on Windows in release; do nothing on macOS / Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tracing_subscriber::EnvFilter;

mod commands;
mod manifest;
mod probe;
mod settings;
mod tray;

use commands::{get_last_status, probe_stack_now, LastStatus};
use probe::probe_stack;
use tray::{build_tray, update_tray};

/// Default poll interval. M1.4 makes this operator-configurable.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Entry point invoked by `src/main.rs`. Tauri 2 convention is to keep
/// the actual app construction in `lib.rs` so mobile targets (iOS /
/// Android) can reuse it without depending on the binary.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logging: Tauri 2 doesn't ship a logger by default. Use
    // tracing_subscriber so log output is visible when launched from
    // Terminal (`open -a "Factotem Doctor.app"` won't show it; for
    // dev, `cargo tauri dev` does).
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,factotem_doctor=debug")),
        )
        .init();

    // Verify recovery manifest parses at startup. If it doesn't, the
    // app still launches but Repair Stack will be unavailable in M1.3.
    if let Err(e) = manifest::load_manifest() {
        tracing::warn!(error = %e, "recovery manifest failed to load");
    }

    let last_status = LastStatus::new();

    let last_status_for_loop = last_status.0.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(last_status)
        .setup(move |app| {
            // Build the tray icon now so it's visible at launch time
            // (initial probe takes ~1s).
            let tray_handle = build_tray(&app.handle())?;
            tracing::info!(tray_id = ?tray_handle.id(), "tray icon installed");

            // Wire menu events to the command router.
            let app_handle = app.handle().clone();
            tray_handle.on_menu_event(move |_app, event| {
                let id = event.id().0.as_str();
                tracing::debug!(menu_event = id, "tray menu event");
                commands::handle_menu_event(&app_handle, id);
            });

            // Spawn the polling loop. Tauri 2 ships with a tokio
            // runtime via the async runtime helpers; we use that
            // rather than starting a parallel one.
            let app_for_loop = app.handle().clone();
            let last_status_clone = last_status_for_loop.clone();
            tauri::async_runtime::spawn(async move {
                run_probe_loop(app_for_loop, last_status_clone).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![probe_stack_now, get_last_status])
        // No windows at startup — this is a tray-only app. M1.3 opens
        // windows on demand via the menu actions.
        .on_window_event(|window, event| {
            // Don't quit on last-window-closed; the tray must stay alive.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().ok();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    // Allow Cmd-Q via the menu to actually quit.
                    let _ = api;
                }
                _ => {}
            }
        });
}

/// Poll the stack every POLL_INTERVAL and update the tray on each tick.
async fn run_probe_loop(
    app: tauri::AppHandle,
    last_status: Arc<Mutex<Option<probe::StackStatus>>>,
) {
    let mut interval = tokio::time::interval(POLL_INTERVAL);
    // Skip the first immediate fire — Tauri's setup() returns slightly
    // before the tray is ready to receive updates. A tiny delay avoids
    // a race where update_tray fires before the menu is built.
    interval.tick().await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    loop {
        let status = probe_stack().await;
        tracing::debug!(
            overall = ?status.overall,
            processes = status.nanoclaw_processes.len(),
            launchd_jobs = status.nanoclaw_launchd.len(),
            "probe tick"
        );

        if let Err(e) = update_tray(&app, &status) {
            tracing::warn!(error = %e, "update_tray failed");
        }

        *last_status.lock() = Some(status);

        interval.tick().await;
    }
}
