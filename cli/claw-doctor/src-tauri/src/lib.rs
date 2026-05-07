// Prevents additional console window on Windows in release; do nothing on macOS / Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tracing_subscriber::EnvFilter;

mod commands;
mod manifest;
mod probe;
mod repair;
mod settings;
mod tray;

use commands::{
    check_for_updates, get_last_status, get_log_path, get_recovery_manifest, get_settings,
    install_update_and_restart, probe_stack_now, save_settings, start_repair, tail_log,
    LastStatus, SettingsState,
};
use probe::{probe_stack, OverallStatus};
use tray::{build_tray, update_tray};

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
    // app still launches but Repair Stack will be unavailable.
    if let Err(e) = manifest::load_manifest() {
        tracing::warn!(error = %e, "recovery manifest failed to load");
    }

    // Load operator preferences before anything else — the autostart
    // plugin registers based on the loaded value, and the probe loop
    // reads `poll_interval_ms` on every tick.
    let settings = settings::load();
    tracing::info!(
        poll_interval_ms = settings.poll_interval_ms,
        launch_at_login = settings.launch_at_login,
        notify_on_state_change = settings.notify_on_state_change,
        "settings loaded"
    );
    let settings_state = SettingsState::new(settings.clone());
    let settings_for_loop = settings_state.0.clone();

    let last_status = LastStatus::new();
    let last_status_for_loop = last_status.0.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // Updater plugin: in-app check + download + install of new
        // releases from github.com/donkruger/factotem. Endpoint + pubkey
        // are declared in tauri.conf.json plugins.updater. The plugin
        // is invoked via the commands in commands.rs; no auto-poll
        // happens until R.3 wires the operator-approved scheduler.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Autostart plugin: pass the launch arg so the spawned instance
        // knows it was started by login (no-op for now, but reserved
        // for "skip first-run UX when relaunched").
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--launched-at-login"]),
        ))
        .manage(last_status)
        .manage(settings_state)
        .setup(move |app| {
            // Build the tray icon now so it's visible at launch time
            // (initial probe takes ~1s).
            let tray_handle = build_tray(&app.handle())?;
            tracing::info!(tray_id = ?tray_handle.id(), "tray icon installed");

            // Sync autostart with the loaded preference. Errors here
            // are non-fatal — operator can flip via Settings later.
            if let Err(e) = sync_autostart_initial(&app.handle(), settings.launch_at_login) {
                tracing::warn!(error = %e, "initial autostart sync failed");
            }

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
            let settings_clone = settings_for_loop.clone();
            tauri::async_runtime::spawn(async move {
                run_probe_loop(app_for_loop, last_status_clone, settings_clone).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_stack_now,
            get_last_status,
            get_recovery_manifest,
            start_repair,
            get_settings,
            save_settings,
            get_log_path,
            tail_log,
            check_for_updates,
            install_update_and_restart,
        ])
        // No windows at startup — this is a tray-only app. Windows open
        // on demand via the menu actions.
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

fn sync_autostart_initial(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let is_enabled = manager.is_enabled().map_err(|e| format!("{}", e))?;
    if enabled && !is_enabled {
        manager.enable().map_err(|e| format!("{}", e))?;
        tracing::info!("autostart enabled at startup");
    } else if !enabled && is_enabled {
        manager.disable().map_err(|e| format!("{}", e))?;
        tracing::info!("autostart disabled at startup");
    }
    Ok(())
}

/// Poll the stack at the operator-configured interval. Each tick:
///   1. Run the probe set in parallel.
///   2. Update the tray icon + menu with the fresh snapshot.
///   3. Cache the snapshot in app state for window queries.
///   4. Fire a system notification if `notify_on_state_change` is set
///      and the overall state changed since the last tick.
async fn run_probe_loop(
    app: tauri::AppHandle,
    last_status: Arc<Mutex<Option<probe::StackStatus>>>,
    settings: Arc<Mutex<settings::Settings>>,
) {
    // Skip the first immediate fire — Tauri's setup() returns slightly
    // before the tray is ready to receive updates. A tiny delay avoids
    // a race where update_tray fires before the menu is built.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let mut prev_overall: Option<OverallStatus> = None;

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

        // Snapshot operator preferences for this tick. Each loop reads
        // them fresh so a Settings save takes effect on the very next
        // tick rather than after a restart.
        let (poll_ms, notify_on_change, notify_audible) = {
            let s = settings.lock();
            (s.clamp_poll(), s.notify_on_state_change, s.notify_audible)
        };

        // Fire state-change notification.
        if notify_on_change {
            if let Some(prev) = prev_overall {
                if prev != status.overall {
                    fire_state_change_notification(
                        &app,
                        prev,
                        status.overall,
                        &status.headline,
                        notify_audible,
                    );
                }
            }
        }
        prev_overall = Some(status.overall);

        *last_status.lock() = Some(status);

        tokio::time::sleep(Duration::from_millis(poll_ms)).await;
    }
}

fn fire_state_change_notification(
    app: &tauri::AppHandle,
    prev: OverallStatus,
    next: OverallStatus,
    headline: &str,
    audible: bool,
) {
    use tauri_plugin_notification::NotificationExt;

    let title = match next {
        OverallStatus::Green => "Factotem stack recovered",
        OverallStatus::Amber => "Factotem stack degraded",
        OverallStatus::Red => "Factotem stack offline",
        OverallStatus::Grey => "Factotem stack starting",
    };
    let body = format!("{} → {}: {}", state_label(prev), state_label(next), headline);

    // Notifications inherit the macOS system-default sound. The
    // `notify_audible` toggle reserved in Settings doesn't yet map
    // cleanly to the v2 plugin's API (no "silent" flag); operators who
    // want quiet notifications can use Focus / Do Not Disturb at the
    // OS level until a follow-up M1.5 wires per-call sound override.
    let _ = audible;

    let builder = app.notification().builder().title(title).body(body);
    if let Err(e) = builder.show() {
        tracing::warn!(error = %e, "notification show failed");
    } else {
        tracing::info!(
            from = ?prev, to = ?next,
            "fired state-change notification"
        );
    }
}

fn state_label(s: OverallStatus) -> &'static str {
    match s {
        OverallStatus::Green => "healthy",
        OverallStatus::Amber => "degraded",
        OverallStatus::Red => "offline",
        OverallStatus::Grey => "starting",
    }
}
