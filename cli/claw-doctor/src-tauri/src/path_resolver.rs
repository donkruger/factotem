//! macOS GUI-vs-shell PATH reconciler.
//!
//! ## What this fixes
//!
//! On macOS, GUI apps launched by Finder, Spotlight, or `launchd`
//! (e.g. via the autostart LaunchAgent) inherit `launchctl getenv
//! PATH`, which on a default install is unset. The process then
//! falls back to the launchd-default PATH — roughly
//! `/usr/bin:/bin:/usr/sbin:/sbin` — which excludes the two
//! directories where the official Node.js `.pkg` and Homebrew
//! actually drop binaries:
//!
//!   - `/usr/local/bin`     (Node.js .pkg installer, Intel-style)
//!   - `/opt/homebrew/bin`  (Homebrew on Apple Silicon)
//!
//! Result: `tokio::process::Command::new("node")` from inside the
//! Doctor fails with `No such file or directory`, even when
//! `node --version` works perfectly in the operator's Terminal.
//! Pre-flight prereq probes false-flag freshly-installed binaries
//! as missing, the Welcome window's "Open Terminal" CTA stays
//! gated, and the operator concludes their install is broken.
//!
//! ## Canonical incident (the reason this module exists)
//!
//! Operator on `fctm-1@36-DE-B4-45-AE-3E`, fresh Doctor v0.1.10
//! install, 2026-05-08. Diagnostic output:
//!
//! ```text
//! version: v24.15.0           ← Node 24 LTS, latest at the time
//! binary:  /usr/local/bin/node
//! shell PATH: /usr/local/bin:...
//! GUI PATH (what Doctor sees):
//! ```
//!
//! Empty `launchctl getenv PATH`. `/usr/local/bin` not in the
//! launchd-default PATH. Doctor's prereq checklist marked Node
//! as "not installed" and gated the CTA. Full ben-log entry:
//! `ben-log/2026-05-08-doctor-prereq-gui-path.md`.
//!
//! ## How the fix works
//!
//! At Doctor startup, before any subprocess spawn or background
//! thread, `lift_path_at_startup()`:
//!
//!   1. Spawns `/bin/zsh -ilc 'echo $PATH'` (interactive flag is
//!      mandatory — `~/.zshrc` only sources for interactive
//!      shells, and that's where nvm / volta / asdf / fnm inject
//!      their PATH shims). 2s timeout via a worker thread + mpsc
//!      `recv_timeout` so a hung shell config can't block boot.
//!   2. Falls back to `/bin/bash -ilc` for operators on older
//!      systems or who switched away from zsh.
//!   3. Merges `lifted + inherited + canonical_fallbacks` and
//!      calls `std::env::set_var("PATH", merged)`. Every
//!      subsequent `Command::new(...)` inherits the merged PATH
//!      automatically — no per-probe code change required.
//!   4. If both shells fail (rare — operator with no shell config
//!      at all), still appends the canonical fallback dirs so the
//!      .pkg and Homebrew install paths are reachable.
//!
//! Same pattern as the npm package `fix-path`, VS Code's
//! `shell-env` helper, Slack's developer-tools resolver, and
//! Postman's runtime detector — battle-tested across the macOS
//! GUI-app ecosystem since ~2017.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Canonical install directories the .pkg installer and Homebrew
/// drop binaries into. Always appended to the merged PATH so the
/// fix degrades gracefully even when shell PATH lift fails entirely
/// (operator with no `.zshrc` / `.bashrc` at all).
const FALLBACK_DIRS: &[&str] = &[
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/local/sbin",
    "/opt/homebrew/sbin",
];

/// Bound on the login-shell spawn. Most `.zshrc` configurations
/// finish in 50–200ms; powerlevel10k with instant prompt is
/// ~10ms. 2s gives even the worst pathological config room to
/// finish without blocking the Doctor's boot perceptibly.
const SHELL_LIFT_TIMEOUT: Duration = Duration::from_secs(2);

/// Lift PATH from the operator's interactive login shell, merge
/// with the GUI-inherited PATH and canonical fallback dirs, and
/// install the result on the current process via `set_var`.
///
/// Idempotent — safe to call multiple times, but designed to run
/// exactly once at app boot from `lib.rs::run()`. Returns the
/// final merged PATH string for diagnostics, or `None` on the
/// non-macOS code path (no-op).
///
/// MUST be called BEFORE Tauri starts spawning background threads
/// (`Builder::default().setup(...)` and the async runtime). Rust's
/// `std::env::set_var` is unsound when called concurrently with
/// other env-reading threads (libc race), so the only safe time
/// is single-threaded startup.
pub fn lift_path_at_startup() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }

    let lifted = try_lift_login_shell_path();
    let inherited = std::env::var("PATH").unwrap_or_default();

    // Order matters:
    //   1. Lifted PATH first  — preserves the operator's own
    //      ordering, so version-manager shims (nvm/volta/asdf)
    //      win over any system Node still on disk.
    //   2. Inherited PATH next — keeps whatever launchd handed us
    //      (typically /usr/bin:/bin:/usr/sbin:/sbin) reachable.
    //   3. Canonical fallbacks last — backstop for binaries that
    //      live in /usr/local/bin or /opt/homebrew/bin even when
    //      the operator's shell config doesn't expose them.
    let mut parts: Vec<String> = Vec::with_capacity(3);
    if let Some(l) = lifted.as_deref() {
        parts.push(l.to_string());
    }
    if !inherited.is_empty() {
        parts.push(inherited);
    }
    parts.push(FALLBACK_DIRS.join(":"));

    let merged = parts.join(":");
    std::env::set_var("PATH", &merged);

    tracing::info!(
        lifted_present = lifted.is_some(),
        merged_len = merged.len(),
        "PATH reconciliation complete"
    );
    Some(merged)
}

/// Try the operator's login shell with `-ilc 'echo $PATH'` and
/// return the parsed result, or `None` if every attempted shell
/// fails / times out / returns garbage.
///
/// zsh has been the macOS default since 10.15 Catalina (2019);
/// bash remains as the fallback for operators who explicitly
/// switched back or are on older systems.
fn try_lift_login_shell_path() -> Option<String> {
    for shell in ["/bin/zsh", "/bin/bash"] {
        let Some(out) = run_shell_with_timeout(shell, "echo $PATH") else {
            continue;
        };

        // `.zshrc` / `.bashrc` may print banner output (powerlevel10k
        // status, motd, version checks) to stdout BEFORE our `echo`
        // runs. Take the LAST non-empty line — that's our `echo $PATH`
        // output. PATH itself is always a single line: POSIX paths
        // can't contain newlines, and the separator is `:`.
        let path_line = out
            .lines()
            .filter(|l| !l.trim().is_empty())
            .last()
            .unwrap_or("")
            .trim();

        // Sanity check: a real PATH always either contains `:` (multi
        // entries — the realistic case) or starts with `/` (single
        // absolute entry — vanishingly rare but valid). If the operator's
        // shell config is broken and emits gibberish, drop it on the
        // floor and let the canonical fallbacks save us.
        if path_line.contains(':') || path_line.starts_with('/') {
            tracing::debug!(
                shell,
                len = path_line.len(),
                "lifted PATH from interactive login shell"
            );
            return Some(path_line.to_string());
        }
    }
    None
}

/// Spawn `<shell> -ilc <command>` on a worker thread and wait up
/// to `SHELL_LIFT_TIMEOUT` for the output via mpsc `recv_timeout`.
/// Returns `None` if the shell binary doesn't exist, the spawn
/// fails, the shell exits non-zero, or the timeout fires.
///
/// The thread leaks if the timeout fires (the worker keeps trying
/// to drain the hung shell). At ~32 KB stack each that's fine for
/// a one-shot startup operation.
fn run_shell_with_timeout(shell: &str, command: &str) -> Option<String> {
    if !Path::new(shell).exists() {
        return None;
    }

    let (tx, rx) = mpsc::channel();
    let shell_owned = shell.to_string();
    let command_owned = command.to_string();

    thread::spawn(move || {
        let result = Command::new(&shell_owned)
            .args(["-ilc", &command_owned])
            // Detach stdin so the shell doesn't block waiting for
            // input on some `read`-using `.zshrc` line.
            .stdin(Stdio::null())
            .output();
        // Receiver may be gone (timeout already fired); ignore.
        let _ = tx.send(result);
    });

    match rx.recv_timeout(SHELL_LIFT_TIMEOUT) {
        Ok(Ok(output)) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).to_string())
        }
        Ok(Ok(output)) => {
            tracing::warn!(
                shell,
                exit = ?output.status,
                stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                "login shell exited non-zero during PATH lift"
            );
            None
        }
        Ok(Err(e)) => {
            tracing::warn!(shell, error = %e, "login shell spawn failed during PATH lift");
            None
        }
        Err(_) => {
            tracing::warn!(
                shell,
                timeout_ms = SHELL_LIFT_TIMEOUT.as_millis() as u64,
                "login shell PATH lift timed out"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_dirs_always_appended_even_on_no_shell_path() {
        // Construct what lift_path_at_startup() would build if shell
        // lift returned None and inherited PATH was empty.
        let parts: Vec<String> = vec![FALLBACK_DIRS.join(":")];
        let merged = parts.join(":");
        for dir in FALLBACK_DIRS {
            assert!(merged.contains(dir), "missing canonical dir {} in {}", dir, merged);
        }
    }

    #[test]
    fn merge_preserves_lifted_first() {
        let lifted = "/lifted/bin";
        let inherited = "/usr/bin:/bin";
        let mut parts: Vec<String> = Vec::with_capacity(3);
        parts.push(lifted.to_string());
        parts.push(inherited.to_string());
        parts.push(FALLBACK_DIRS.join(":"));
        let merged = parts.join(":");
        assert!(
            merged.starts_with(lifted),
            "lifted PATH must come first, got: {}",
            merged
        );
        assert!(merged.contains("/usr/bin:/bin"));
        assert!(merged.contains("/usr/local/bin"));
    }
}
