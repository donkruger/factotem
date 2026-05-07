//! Operator preferences for the Doctor.
//!
//! Persistent keys:
//!   - poll_interval_ms (default: 5000) — how often the probe runs.
//!     Min 1000, max 60000. M1.4 honours this in `lib.rs::run_probe_loop`.
//!   - launch_at_login (default: true) — registers/unregisters via the
//!     tauri-plugin-autostart plugin.
//!   - notify_on_state_change (default: true) — fire a system notification
//!     whenever overall state transitions (green↔amber↔red).
//!   - notify_audible (default: false) — when true, notifications use the
//!     default sound; when false, they're silent.
//!   - hide_until_amber (default: false) — reserved for a future M1.5
//!     "quiet mode" where the icon hides while the stack is green.
//!
//! Storage: `~/Library/Application Support/Factotem/doctor-settings.json`,
//! mode 0o600. This sits alongside the recovery panel and the dashboard
//! static export — the same TCC-friendly Application Support tree the
//! 2026-05-07 EPERM migration moved everything into.
//!
//! Atomic write: write to `<path>.tmp` and rename. Survives crashes and
//! avoids partial-file reads from a concurrent invocation.

use std::fs;
use std::io;
use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub poll_interval_ms: u64,
    pub launch_at_login: bool,
    pub notify_on_state_change: bool,
    pub notify_audible: bool,
    pub hide_until_amber: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            poll_interval_ms: 5_000,
            launch_at_login: true,
            notify_on_state_change: true,
            notify_audible: false,
            hide_until_amber: false,
        }
    }
}

impl Settings {
    /// Bound poll_interval_ms to a sane range. Below 1s the probe loop
    /// thrashes Docker / launchctl; above 60s the menu-bar feedback loop
    /// gets too sluggish to be useful.
    pub fn clamp_poll(&self) -> u64 {
        self.poll_interval_ms.clamp(1_000, 60_000)
    }
}

/// Resolve the on-disk path of the settings file.
/// macOS canonical location: `~/Library/Application Support/Factotem/doctor-settings.json`.
/// On non-macOS hosts (which the Doctor doesn't currently target) the
/// path falls back to `~/.config/factotem/doctor-settings.json`.
pub fn settings_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME not set".to_string())?;
    let mut path = PathBuf::from(home);
    if cfg!(target_os = "macos") {
        path.push("Library");
        path.push("Application Support");
        path.push("Factotem");
    } else {
        path.push(".config");
        path.push("factotem");
    }
    path.push("doctor-settings.json");
    Ok(path)
}

/// Load settings from disk, or return Default on first run / read error.
/// Errors are logged but not propagated — the Doctor should always boot,
/// even on a corrupted settings file (the operator gets defaults until
/// they save again).
pub fn load() -> Settings {
    let path = match settings_path() {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "settings_path failed; using defaults");
            return Settings::default();
        }
    };

    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            tracing::info!(path = %path.display(), "no settings file yet; using defaults");
            return Settings::default();
        }
        Err(e) => {
            tracing::warn!(error = %e, path = %path.display(), "settings read failed; using defaults");
            return Settings::default();
        }
    };

    match serde_json::from_str::<Settings>(&raw) {
        Ok(s) => {
            tracing::debug!(path = %path.display(), "settings loaded");
            s
        }
        Err(e) => {
            tracing::warn!(error = %e, path = %path.display(), "settings parse failed; using defaults");
            Settings::default()
        }
    }
}

/// Persist settings atomically. Returns Ok on success or a brief error
/// string suitable for surfacing in the UI.
pub fn save(settings: &Settings) -> Result<(), String> {
    let path = settings_path().map_err(|e| format!("path: {}", e))?;
    let dir = path
        .parent()
        .ok_or_else(|| "settings path has no parent".to_string())?;

    fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    #[cfg(unix)]
    {
        if let Err(e) = fs::set_permissions(dir, fs::Permissions::from_mode(0o700)) {
            tracing::warn!(error = %e, dir = %dir.display(), "chmod 0o700 on settings dir failed");
        }
    }

    let tmp = path.with_extension("json.tmp");
    let serialised = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("serialize: {}", e))?;

    fs::write(&tmp, serialised).map_err(|e| format!("write {}: {}", tmp.display(), e))?;

    #[cfg(unix)]
    {
        if let Err(e) = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)) {
            tracing::warn!(error = %e, "chmod 0o600 on settings tmp failed");
        }
    }

    fs::rename(&tmp, &path).map_err(|e| format!("rename {}: {}", path.display(), e))?;
    tracing::info!(path = %path.display(), "settings saved");
    Ok(())
}
