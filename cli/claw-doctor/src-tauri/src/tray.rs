//! Tray icon construction + status-driven menu builder.

use crate::probe::{OverallStatus, StackStatus};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Wry};

/// Menu item IDs. Keep these stable — `commands.rs` matches on them.
pub mod ids {
    pub const HEADLINE: &str = "headline";
    pub const DETAIL: &str = "detail";
    pub const LAST_CHECKED: &str = "last_checked";
    pub const OPEN_DASHBOARD: &str = "open_dashboard";
    pub const OPEN_RECOVERY: &str = "open_recovery";
    pub const REPAIR_STACK: &str = "repair_stack";
    pub const PULL_UPDATES: &str = "pull_updates"; // v0.1.8 — pull + build + restart upstream changes
    pub const SETUP_NANOCLAW: &str = "setup_nanoclaw"; // R.7 — replaces REPAIR_STACK in NotInstalled state
    pub const SHOW_DETAILS: &str = "show_details";
    pub const OPEN_SETTINGS: &str = "open_settings";
    pub const OPEN_LOGS: &str = "open_logs";
    pub const QUIT: &str = "quit";
}

/// Build the tray icon at startup. The menu is replaced on every probe
/// tick via [`update_tray`].
pub fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let menu = build_initial_menu(app)?;
    TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .icon(app.default_window_icon().unwrap().clone())
        .icon_as_template(true)
        .tooltip("Factotem Doctor — checking…")
        .build(app)
}

fn build_initial_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let headline = MenuItem::with_id(
        app,
        ids::HEADLINE,
        "Checking dashboard…",
        false,
        None::<&str>,
    )?;
    let last_checked = MenuItem::with_id(
        app,
        ids::LAST_CHECKED,
        "Last checked: —",
        false,
        None::<&str>,
    )?;
    let open_dashboard = MenuItem::with_id(
        app,
        ids::OPEN_DASHBOARD,
        "Open Dashboard",
        true,
        Some("CmdOrCtrl+Shift+D"),
    )?;
    let open_recovery = MenuItem::with_id(
        app,
        ids::OPEN_RECOVERY,
        "Open Recovery Panel",
        true,
        Some("CmdOrCtrl+Shift+R"),
    )?;
    let open_settings = MenuItem::with_id(
        app,
        ids::OPEN_SETTINGS,
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let open_logs = MenuItem::with_id(
        app,
        ids::OPEN_LOGS,
        "View NanoClaw logs…",
        true,
        Some("CmdOrCtrl+Shift+L"),
    )?;
    let quit = MenuItem::with_id(
        app,
        ids::QUIT,
        "Quit Factotem Doctor",
        true,
        Some("CmdOrCtrl+Q"),
    )?;

    Menu::with_items(
        app,
        &[
            &headline,
            &last_checked,
            &PredefinedMenuItem::separator(app)?,
            &open_dashboard,
            &open_recovery,
            &open_logs,
            &PredefinedMenuItem::separator(app)?,
            &open_settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

/// Update the tray's tooltip + menu after each probe tick.
pub fn update_tray(app: &AppHandle, status: &StackStatus) -> tauri::Result<()> {
    let tray = match app.tray_by_id("main") {
        Some(t) => t,
        None => return Ok(()),
    };

    // Tooltip is a single line — visible on hover even when the menu
    // hasn't been opened. Encode the headline + state.
    let dot = match status.overall {
        OverallStatus::Green => "🟢",
        OverallStatus::Amber => "🟡",
        OverallStatus::Red => "🔴",
        OverallStatus::Grey => "⚪",
        OverallStatus::NotInstalled => "🔵",
    };
    let tooltip = format!("{}  {}", dot, status.headline);
    tray.set_tooltip(Some(&tooltip))?;

    // Rebuild the menu so the headline/detail/timestamp reflect the
    // latest snapshot. Tauri 2 doesn't expose a "patch" API for menu
    // items, but full rebuild is cheap (tens of microseconds).
    let menu = build_status_menu(app, status)?;
    tray.set_menu(Some(menu))?;

    Ok(())
}

fn build_status_menu(app: &AppHandle, status: &StackStatus) -> tauri::Result<Menu<Wry>> {
    let dot = match status.overall {
        OverallStatus::Green => "🟢",
        OverallStatus::Amber => "🟡",
        OverallStatus::Red => "🔴",
        OverallStatus::Grey => "⚪",
        OverallStatus::NotInstalled => "🔵",
    };
    let headline = MenuItem::with_id(
        app,
        ids::HEADLINE,
        format!("{}  {}", dot, status.headline),
        false,
        None::<&str>,
    )?;

    // Detail row only renders when the snapshot has one (amber / red
    // states explain the situation; green collapses to a single line).
    let detail_item = if let Some(d) = &status.detail {
        Some(MenuItem::with_id(
            app,
            ids::DETAIL,
            truncate_for_menu(d),
            false,
            None::<&str>,
        )?)
    } else {
        None
    };

    let last_checked_label =
        format_last_checked(&status.last_probed_at);
    let last_checked = MenuItem::with_id(
        app,
        ids::LAST_CHECKED,
        last_checked_label,
        false,
        None::<&str>,
    )?;

    // R.7 — gate items on the probe's overall state. NotInstalled
    // operators (fresh-install Doctor, no orchestrator yet) see a
    // friendlier surface: "Set up NanoClaw…" replaces "Repair Stack…",
    // dashboard + logs are disabled with greyed labels that explain why.
    let is_not_installed = matches!(status.overall, OverallStatus::NotInstalled);

    let dashboard_label = if is_not_installed {
        "Open Dashboard (NanoClaw not installed)"
    } else if status.nanoclaw_http.ok {
        "Open Dashboard"
    } else {
        "Open Dashboard (offline)"
    };
    let open_dashboard = MenuItem::with_id(
        app,
        ids::OPEN_DASHBOARD,
        dashboard_label,
        // Disabled when HTTP unreachable OR not installed — both produce
        // an unreachable URL.
        !is_not_installed && status.nanoclaw_http.ok,
        Some("CmdOrCtrl+Shift+D"),
    )?;
    let open_recovery = MenuItem::with_id(
        app,
        ids::OPEN_RECOVERY,
        "Open Recovery Panel",
        // Always enabled — the bundled recovery.html ships with the
        // Doctor (R.7), so this works on completely fresh installs.
        true,
        Some("CmdOrCtrl+Shift+R"),
    )?;

    // Repair Stack OR Set up NanoClaw — same menu slot, different
    // verb depending on state. NotInstalled state opens the welcome
    // window in setup mode; configured state opens the typed-confirm
    // Repair Stack window (destructive).
    let repair_stack = if is_not_installed {
        MenuItem::with_id(
            app,
            ids::SETUP_NANOCLAW,
            "Set up NanoClaw…",
            true,
            None::<&str>,
        )?
    } else {
        MenuItem::with_id(
            app,
            ids::REPAIR_STACK,
            "Repair Stack…",
            true,
            None::<&str>,
        )?
    };

    // v0.1.8 — Pull upstream updates. Disabled when the orchestrator
    // isn't installed yet (no source tree to pull); the action itself
    // does its own preflight (working tree clean, no diverged commits)
    // before mutating anything.
    let pull_updates = MenuItem::with_id(
        app,
        ids::PULL_UPDATES,
        if is_not_installed {
            "Pull upstream updates (NanoClaw not installed)"
        } else {
            "Pull upstream updates…"
        },
        !is_not_installed,
        None::<&str>,
    )?;

    // "Show details" surfaces multi-instance / foreign-port-owner /
    // per-probe-detail in a small read-only window. Implemented as
    // M1.3-stub here; the window UI lands later in M1.3 if budget allows.
    let show_details = MenuItem::with_id(
        app,
        ids::SHOW_DETAILS,
        "Show diagnostic details",
        true,
        None::<&str>,
    )?;

    // M1.4 entries — operator preferences + log tail.
    let open_settings = MenuItem::with_id(
        app,
        ids::OPEN_SETTINGS,
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    // R.7: disable logs viewer when there's no installation to log from.
    let logs_label = if is_not_installed {
        "View NanoClaw logs (no log file yet)"
    } else {
        "View NanoClaw logs…"
    };
    let open_logs = MenuItem::with_id(
        app,
        ids::OPEN_LOGS,
        logs_label,
        !is_not_installed,
        Some("CmdOrCtrl+Shift+L"),
    )?;

    let quit = MenuItem::with_id(
        app,
        ids::QUIT,
        "Quit Factotem Doctor",
        true,
        Some("CmdOrCtrl+Q"),
    )?;

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = vec![&headline];
    if let Some(d) = detail_item.as_ref() {
        items.push(d);
    }
    let sep1 = PredefinedMenuItem::separator(app)?;
    items.push(&last_checked);
    items.push(&sep1);
    items.push(&open_dashboard);
    items.push(&open_recovery);
    let sep_actions = PredefinedMenuItem::separator(app)?;
    items.push(&sep_actions);
    items.push(&repair_stack);
    items.push(&pull_updates);
    items.push(&show_details);
    items.push(&open_logs);
    let sep_settings = PredefinedMenuItem::separator(app)?;
    items.push(&sep_settings);
    items.push(&open_settings);
    let sep2 = PredefinedMenuItem::separator(app)?;
    items.push(&sep2);
    items.push(&quit);

    Menu::with_items(app, &items)
}

fn truncate_for_menu(s: &str) -> String {
    // Bumped from 80 → 130 so the multi-instance detail line fits without
    // chopping at ":78…" (verified against Don's 2026-05-07 screenshot).
    // macOS menus comfortably render up to ~140 chars per item before
    // visual wrapping; 130 leaves a safety margin.
    const MAX: usize = 130;
    if s.len() <= MAX {
        s.to_string()
    } else {
        format!("{}…", &s[..MAX - 1])
    }
}

fn format_last_checked(when: &chrono::DateTime<chrono::Utc>) -> String {
    let elapsed = chrono::Utc::now().signed_duration_since(*when);
    let secs = elapsed.num_seconds();
    if secs < 5 {
        "Last checked: just now".to_string()
    } else if secs < 60 {
        format!("Last checked: {}s ago", secs)
    } else if secs < 3600 {
        format!("Last checked: {}m ago", secs / 60)
    } else {
        format!("Last checked: {}h ago", secs / 3600)
    }
}
