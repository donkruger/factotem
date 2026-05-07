//! Recovery-step manifest — read by the M1.3 Repair Stack window.
//!
//! M1.2 stub: the manifest type is defined here, but no consumer exists
//! yet. The actual JSON file (`recovery-steps.json`) is bundled with
//! the app and loaded at startup. Keeping the loader here so M1.3 only
//! has to wire the consumer.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryManifest {
    pub schema_version: u32,
    pub steps: Vec<RecoveryStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryStep {
    pub id: String,
    pub title: String,
    pub why: String,
    pub command: String,
    pub timeout_ms: u64,
    pub required: bool,
    pub verify: Option<VerifyStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyStep {
    pub command: String,
    pub timeout_ms: u64,
    /// How long to keep retrying the verify probe before declaring
    /// the step failed (e.g., Docker takes 30+ seconds to fully start).
    pub max_wait_ms: u64,
    /// Poll interval inside the max_wait_ms window.
    pub poll_ms: u64,
}

/// Load the manifest bundled with the app. The JSON lives under
/// `src-tauri/recovery-steps.json` and is bundled via Cargo's
/// `include_str!` macro at build time.
pub fn load_manifest() -> Result<RecoveryManifest, String> {
    const RAW: &str = include_str!("../recovery-steps.json");
    serde_json::from_str(RAW).map_err(|e| format!("recovery-steps.json parse: {}", e))
}
