// Prevents additional console window on Windows in release; do nothing on macOS / Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::Emitter;
use tracing_subscriber::EnvFilter;

mod commands;
mod manifest;
mod probe;
mod repair;
mod settings;
mod tray;

use commands::{
    check_for_updates, dismiss_welcome, get_current_version, get_last_status, get_log_path,
    get_recovery_manifest, get_settings, install_update_and_restart, is_first_run,
    open_setup_in_terminal, open_welcome_window, probe_stack_now, save_settings, start_repair,
    tail_log, LastStatus, SettingsState,
};
use tauri::Manager;
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
        // R.7 — single-instance enforcement. Wired BEFORE other plugins
        // so it gates the entire app: a second invocation of the same
        // binary (e.g. autostart's launchd bootstrap firing while the
        // operator's manual launch is also alive) calls into this
        // closure to focus the existing window, then exits cleanly.
        // Eliminates the duplicate-icon class of bug.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tracing::info!("second instance attempted — focusing welcome window if present");
            if let Some(w) = app.get_webview_window("welcome") {
                let _ = w.show();
                let _ = w.set_focus();
            } else if let Some(w) = app.webview_windows().values().next().cloned() {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
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

            // R.7 — remediate a stale autostart plist. Operators who
            // first ran the Doctor from `target/release/bundle/...`
            // and later moved to `/Applications/Factotem Doctor.app`
            // end up with a plist whose ProgramArguments[0] points at
            // the old source-tree path. launchd's RunAtLoad then
            // spawns a stale binary (often killed by single-instance
            // detection but visible briefly as a duplicate tray icon).
            // Fix: detect the path mismatch and regenerate via
            // disable() → enable().
            if settings.launch_at_login {
                if let Err(e) = remediate_stale_plist(&app.handle()) {
                    tracing::warn!(error = %e, "stale-plist remediation failed");
                }
            }

            // R.7 — auto-open the welcome window on first launch.
            // The React side reads probe state to decide whether to
            // render state A (stack detected) or state B (NotInstalled).
            // After the operator clicks "Got it", `dismiss_welcome`
            // flips first_run_completed to true and this branch stops
            // firing on subsequent launches.
            if !settings.first_run_completed {
                tracing::info!("first run — auto-opening welcome window");
                open_welcome_window(&app.handle());
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

            // Spawn the update-check loop. Polls GitHub releases every
            // UPDATE_CHECK_INTERVAL when `auto_check_updates` is true.
            // Operator-approved install — this loop only DETECTS updates
            // and emits an event; the frontend prompts the operator and
            // calls `install_update_and_restart` on their click.
            let app_for_updates = app.handle().clone();
            let settings_for_updates = settings_for_loop.clone();
            tauri::async_runtime::spawn(async move {
                run_update_check_loop(app_for_updates, settings_for_updates).await;
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
            get_current_version,
            is_first_run,
            dismiss_welcome,
            open_setup_in_terminal,
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

/// R.7 — Detect + repair a stale autostart plist. The autostart plugin
/// records the binary path at the moment `enable()` was first called.
/// Operators who first ran the Doctor from `target/release/bundle/...`
/// and later moved to `/Applications/Factotem Doctor.app/...` end up
/// with a plist whose ProgramArguments[0] points at the obsolete path.
/// launchd's RunAtLoad then spawns the stale binary on every login;
/// single-instance detection kills it, but it's visible briefly as a
/// duplicate tray icon. Fix: compare the plist's ProgramArguments[0]
/// to `current_exe()`; if they differ, disable + re-enable autostart
/// so the plugin regenerates the plist with the right path.
fn remediate_stale_plist(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;

    // Resolve the canonical plist path (macOS only — guard against
    // non-macOS hosts that might run the Doctor in dev).
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME not set".to_string())?;
    let plist = std::path::PathBuf::from(home)
        .join("Library/LaunchAgents/Factotem Doctor.plist");
    if !plist.exists() {
        // No plist yet — nothing to remediate. The autostart plugin
        // will write a fresh one on next enable().
        return Ok(());
    }

    // Extract the first ProgramArguments entry — that's the binary path.
    let out = std::process::Command::new("/usr/bin/plutil")
        .args([
            "-extract",
            "ProgramArguments.0",
            "raw",
            "-o",
            "-",
            plist.to_str().unwrap_or(""),
        ])
        .output()
        .map_err(|e| format!("plutil spawn: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "plutil exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let plist_path = String::from_utf8_lossy(&out.stdout).trim().to_string();

    // Resolve the running binary's path.
    let current = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
    let current_str = current.to_string_lossy().to_string();

    if plist_path == current_str {
        tracing::debug!(plist = %plist_path, "plist path matches current_exe — no remediation needed");
        return Ok(());
    }

    tracing::info!(
        plist = %plist_path,
        current = %current_str,
        "plist path stale — regenerating via disable+enable"
    );

    let manager = app.autolaunch();
    manager.disable().map_err(|e| format!("disable: {}", e))?;
    manager.enable().map_err(|e| format!("enable: {}", e))?;
    tracing::info!("plist regenerated with current_exe()");
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
        OverallStatus::NotInstalled => "NanoClaw not installed",
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
        OverallStatus::NotInstalled => "not installed",
    }
}

// ──────────────────────────────────────────────────────────────────────
// R.3 — Update-check loop.
//
// Polls GitHub Releases' `latest.json` every UPDATE_CHECK_INTERVAL.
// When a newer version than the running binary is found, fires:
//   1. A Tauri event `update-available` with the version + body.
//   2. A system notification ("Factotem Doctor v0.X.Y available").
//   3. State that the tray menu's `update_available` field consumes
//      to surface a "📦 Update available" headline (see tray.rs).
//
// Operator-approved install — we only DETECT updates here. The
// frontend banner + Settings window's button drive `install_update_and_restart`.
// ──────────────────────────────────────────────────────────────────────

const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60); // 4h
const UPDATE_CHECK_INITIAL_DELAY: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, serde::Serialize)]
struct UpdateAvailableEvent {
    version: String,
    current_version: String,
    body: Option<String>,
}

async fn run_update_check_loop(
    app: tauri::AppHandle,
    settings: Arc<Mutex<settings::Settings>>,
) {
    // Small initial delay so the first check doesn't compete with the
    // probe loop's first tick + the tray rebuild.
    tokio::time::sleep(UPDATE_CHECK_INITIAL_DELAY).await;

    let current_version = app.package_info().version.to_string();

    loop {
        let auto_check = settings.lock().auto_check_updates;
        if auto_check {
            match try_check_update(&app, &current_version).await {
                Ok(Some(info)) => {
                    tracing::info!(
                        new_version = %info.version,
                        current = %current_version,
                        "update detected"
                    );
                    record_update_check(&settings);
                    fire_update_notification(&app, &info);
                    let _ = app.emit("update-available", &info);
                }
                Ok(None) => {
                    tracing::debug!(current = %current_version, "no update available");
                    record_update_check(&settings);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "update check failed");
                    record_update_check(&settings);
                }
            }
        } else {
            tracing::debug!("auto_check_updates is off — skipping");
        }
        tokio::time::sleep(UPDATE_CHECK_INTERVAL).await;
    }
}

async fn try_check_update(
    app: &tauri::AppHandle,
    current_version: &str,
) -> Result<Option<UpdateAvailableEvent>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| format!("{}", e))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateAvailableEvent {
            version: update.version.clone(),
            current_version: current_version.to_string(),
            body: update.body.clone(),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(format!("{}", e)),
    }
}

fn record_update_check(settings: &Arc<Mutex<settings::Settings>>) {
    let now = chrono::Utc::now().to_rfc3339();
    let snapshot = {
        let mut s = settings.lock();
        s.last_update_check_at = Some(now);
        s.clone()
    };
    // Best-effort persistence — never fails the loop.
    if let Err(e) = settings::save(&snapshot) {
        tracing::warn!(error = %e, "could not persist last_update_check_at");
    }
}

fn fire_update_notification(app: &tauri::AppHandle, info: &UpdateAvailableEvent) {
    use tauri_plugin_notification::NotificationExt;
    let title = format!("Factotem Doctor v{} available", info.version);
    let body = format!(
        "Currently running v{}. Open Settings → Updates to install.",
        info.current_version
    );
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!(error = %e, "update notification failed");
    }
}
