//! Operator preferences — placeholder for M1.4.
//!
//! Persistent keys (planned):
//!   - poll_interval_ms (default: 5000)
//!   - launch_at_login (default: true)
//!   - notify_on_state_change (default: true)
//!   - notify_audible (default: false; debounced > 30s)
//!   - hide_until_amber (default: false; if true, icon hides while green)

use serde::{Deserialize, Serialize};

// M1.4 will start consuming Settings; the struct is plumbed early so
// the schema is stable and the placeholder is type-checked.
#[allow(dead_code)]
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

// M1.4 implements load() / save() against
// ~/Library/Application Support/Factotem/doctor-settings.json
