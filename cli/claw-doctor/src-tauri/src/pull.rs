//! Pull-upstream-updates executor (v0.1.8).
//!
//! The Doctor binary auto-updates via the Tauri updater (R.1–R.6), but the
//! orchestrator + dashboard + claw-setup wizard ship via the fork-and-modify
//! workflow (`git pull` + `npm run build` per README). For un-customised
//! deployments this leaves the operator manually pulling+building the
//! source tree on every release. This module bridges that gap with a
//! one-click "Pull updates" action that:
//!
//!   1. Locates the orchestrator source tree (via `WorkingDirectory` in
//!      `~/Library/LaunchAgents/com.nanoclaw.plist`, falling back to the
//!      documented installer path `~/factotem`).
//!   2. Runs preflight safety checks — refuses to mutate a repo that has
//!      uncommitted changes, isn't on `main`, or has local-only commits
//!      ahead of `origin/main`. Customised forks stay untouched.
//!   3. Runs the standard pull-build-restart sequence.
//!   4. Verifies `/health` comes back up.
//!
//! The execution shape mirrors Repair Stack — same per-step state machine,
//! same `RepairEvent` payload shape, just a different Tauri event channel
//! (`pull-progress`) so the two UIs don't bleed into each other.

use std::path::PathBuf;

use tauri::AppHandle;

use crate::manifest::{RecoveryManifest, RecoveryStep, VerifyStep};
use crate::repair::{run_steps_chain, RepairResult};

pub const PULL_EVENT: &str = "pull-progress";
pub const PULL_CONFIRM_PHRASE: &str = "PULL UPDATES";

/// Resolve the orchestrator source tree on disk. Tries:
///   1. `WorkingDirectory` key in `com.nanoclaw.plist` (set by claw-setup
///      step 09 when launchd is installed).
///   2. `$HOME/factotem` — the documented installer path from the welcome
///      one-liner (`git clone … && cd factotem && npm run claw-setup`).
///   3. `$HOME/Documents/NanoClaw/nanoclaw` — Don's dev-machine fallback,
///      same one `resolve_nanoclaw_log_path` falls back to.
/// Returns None if no candidate exists. Each candidate is also gated on
/// being a git repo (.git/ present) so we never try to `git pull` a
/// directory that just happens to share the path.
pub fn resolve_orchestrator_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;

    // Path 1 — read the launchd plist via plutil.
    let plist = PathBuf::from(&home).join("Library/LaunchAgents/com.nanoclaw.plist");
    if plist.exists() {
        if let Ok(out) = std::process::Command::new("/usr/bin/plutil")
            .args([
                "-extract",
                "WorkingDirectory",
                "raw",
                "-o",
                "-",
                plist.to_str().unwrap_or(""),
            ])
            .output()
        {
            if out.status.success() {
                let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !raw.is_empty() {
                    let p = PathBuf::from(raw);
                    if is_git_repo(&p) {
                        return Some(p);
                    }
                }
            }
        }
    }

    // Path 2 — installer default.
    let installer_default = PathBuf::from(&home).join("factotem");
    if is_git_repo(&installer_default) {
        return Some(installer_default);
    }

    // Path 3 — dev-machine fallback.
    let dev_fallback = PathBuf::from(&home).join("Documents/NanoClaw/nanoclaw");
    if is_git_repo(&dev_fallback) {
        return Some(dev_fallback);
    }

    None
}

fn is_git_repo(p: &std::path::Path) -> bool {
    p.is_dir() && p.join(".git").exists()
}

/// Build the pull-updates manifest. The orchestrator root is interpolated
/// into every step so each command runs in the right cwd. Each shell
/// command is a single-quoted bash string; the path is properly quoted
/// so spaces in the path don't break the chain.
pub fn build_pull_manifest(root: &std::path::Path) -> RecoveryManifest {
    let root_q = shell_escape(&root.display().to_string());
    let dash = format!("{}/dashboard", root.display());
    let dash_q = shell_escape(&dash);

    // Common preamble that fails the step with a clear message when the
    // git working tree isn't ready for a fast-forward pull. Embedded into
    // each preflight command so the failure detail (captured from stderr
    // by run_shell_bash) reads like a real explanation, not "exit 1".
    RecoveryManifest {
        schema_version: 1,
        steps: vec![
            RecoveryStep {
                id: "preflight-clean".into(),
                title: "Working tree is clean".into(),
                why: "Refuses to overwrite uncommitted edits — your local changes stay safe."
                    .into(),
                command: format!(
                    r#"cd {root} && if [ -n "$(git status --porcelain)" ]; then echo "Uncommitted changes detected:" >&2; git status --short >&2; exit 1; fi"#,
                    root = root_q
                ),
                timeout_ms: 5_000,
                required: true,
                verify: None,
            },
            RecoveryStep {
                id: "preflight-branch".into(),
                title: "On main branch".into(),
                why: "Pull only updates main. If you're on a feature branch, switch first."
                    .into(),
                command: format!(
                    r#"cd {root} && b="$(git rev-parse --abbrev-ref HEAD)"; if [ "$b" != "main" ]; then echo "Currently on branch '$b', expected 'main'" >&2; exit 1; fi"#,
                    root = root_q
                ),
                timeout_ms: 5_000,
                required: true,
                verify: None,
            },
            RecoveryStep {
                id: "fetch".into(),
                title: "Fetch upstream changes".into(),
                why: "Updates your local view of origin/main without modifying your working tree."
                    .into(),
                command: format!("cd {root} && git fetch origin main", root = root_q),
                timeout_ms: 30_000,
                required: true,
                verify: None,
            },
            RecoveryStep {
                id: "preflight-no-divergence".into(),
                title: "No local-only commits ahead of origin/main".into(),
                why: "Customised forks have local commits — refusing to fast-forward them keeps your work intact."
                    .into(),
                command: format!(
                    r#"cd {root} && ahead="$(git rev-list --count origin/main..main)"; if [ "$ahead" != "0" ]; then echo "$ahead local-only commit(s) ahead of origin/main — pull would clobber them" >&2; git log --oneline origin/main..main >&2; exit 1; fi"#,
                    root = root_q
                ),
                timeout_ms: 5_000,
                required: true,
                verify: None,
            },
            RecoveryStep {
                id: "pull".into(),
                title: "Fast-forward pull".into(),
                why: "Brings origin/main into your working tree. --ff-only refuses if a merge would be required.".into(),
                command: format!("cd {root} && git pull --ff-only origin main", root = root_q),
                timeout_ms: 30_000,
                required: true,
                verify: None,
            },
            RecoveryStep {
                id: "install-orchestrator".into(),
                title: "Install orchestrator dependencies".into(),
                why: "Picks up any new packages in package.json since the last build.".into(),
                command: format!("cd {root} && npm install --silent", root = root_q),
                timeout_ms: 240_000,
                required: true,
                verify: None,
            },
            RecoveryStep {
                id: "build-orchestrator".into(),
                title: "Build orchestrator (tsc)".into(),
                why: "Compiles src/ to dist/ — what launchd actually runs.".into(),
                command: format!("cd {root} && npm run build", root = root_q),
                timeout_ms: 120_000,
                required: true,
                verify: None,
            },
            RecoveryStep {
                id: "install-dashboard".into(),
                title: "Install dashboard dependencies".into(),
                why: "Same as orchestrator step but for the Next.js dashboard package.".into(),
                command: format!("cd {dash} && npm install --silent", dash = dash_q),
                timeout_ms: 240_000,
                required: true,
                verify: None,
            },
            RecoveryStep {
                id: "build-dashboard".into(),
                title: "Build dashboard (next build)".into(),
                why: "Static-export Next 16 build → dashboard/out/, mounted by the orchestrator's HTTP server."
                    .into(),
                command: format!("cd {dash} && npm run build", dash = dash_q),
                timeout_ms: 180_000,
                required: true,
                verify: None,
            },
            RecoveryStep {
                id: "restart".into(),
                title: "Restart the orchestrator".into(),
                why: "launchctl kickstart picks up the freshly compiled dist/. WhatsApp pairing + group state survive."
                    .into(),
                command: "launchctl kickstart -k gui/$(id -u)/com.nanoclaw".into(),
                timeout_ms: 10_000,
                required: true,
                verify: None,
            },
            RecoveryStep {
                id: "verify".into(),
                title: "Verify dashboard is reachable".into(),
                why: "Polls /health for up to 30s — the orchestrator takes a few seconds to bind port 7842 after restart."
                    .into(),
                command: "true".into(),
                timeout_ms: 5_000,
                required: true,
                verify: Some(VerifyStep {
                    command: "curl -sf http://localhost:7842/health".into(),
                    timeout_ms: 5_000,
                    max_wait_ms: 30_000,
                    poll_ms: 1_500,
                }),
            },
        ],
    }
}

/// Run the pull-updates sequence. Resolves the orchestrator root, builds
/// the manifest, and delegates to the shared step-chain runner with the
/// `pull-progress` event channel.
pub async fn run_pull(app: AppHandle) -> Result<RepairResult, String> {
    let root = resolve_orchestrator_root().ok_or_else(|| {
        "Could not locate the orchestrator source tree. Tried com.nanoclaw.plist's WorkingDirectory, ~/factotem, and ~/Documents/NanoClaw/nanoclaw."
            .to_string()
    })?;
    let manifest = build_pull_manifest(&root);
    let result = run_steps_chain(app, manifest, PULL_EVENT).await;
    Ok(result)
}

/// Single-quote-escape for bash. Wraps in single quotes and replaces any
/// embedded single quote with the standard `'\''` (close-quote, escape,
/// reopen-quote) idiom. Safe for any string.
fn shell_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_escape_handles_no_special() {
        assert_eq!(shell_escape("/Users/foo/factotem"), "'/Users/foo/factotem'");
    }

    #[test]
    fn shell_escape_handles_embedded_quote() {
        assert_eq!(shell_escape("foo'bar"), r#"'foo'\''bar'"#);
    }

    #[test]
    fn shell_escape_handles_spaces() {
        assert_eq!(
            shell_escape("/Users/foo/My Stuff/factotem"),
            "'/Users/foo/My Stuff/factotem'"
        );
    }

    #[test]
    fn manifest_has_expected_step_count() {
        let m = build_pull_manifest(std::path::Path::new("/tmp/nanoclaw"));
        assert_eq!(m.steps.len(), 11);
        assert_eq!(m.steps[0].id, "preflight-clean");
        assert_eq!(m.steps.last().unwrap().id, "verify");
    }
}
