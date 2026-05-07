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
    pub const SHOW_DETAILS: &str = "show_details";
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

    let open_dashboard = MenuItem::with_id(
        app,
        ids::OPEN_DASHBOARD,
        "Open Dashboard",
        // Disable when NanoClaw HTTP is unreachable — the link would
        // just produce a connection-refused error.
        status.nanoclaw_http.ok,
        Some("CmdOrCtrl+Shift+D"),
    )?;
    let open_recovery = MenuItem::with_id(
        app,
        ids::OPEN_RECOVERY,
        "Open Recovery Panel",
        true,
        Some("CmdOrCtrl+Shift+R"),
    )?;

    // Repair Stack — destructive, env-of-design typed-confirm gated.
    // The button is enabled even when state is green (operator may want
    // to manually run a repair after a config edit); the *window* itself
    // surfaces the typed-confirm gate.
    let repair_stack = MenuItem::with_id(
        app,
        ids::REPAIR_STACK,
        "Repair Stack…",
        true,
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
    items.push(&show_details);
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
