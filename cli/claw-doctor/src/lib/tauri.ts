// Typed wrappers around the Tauri command surface defined in
// `src-tauri/src/commands.rs`. Keeps `invoke('cmd_name', payload)` calls
// out of the React components and makes types reviewable in one place.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ──────────────────────────────────────────────────────────────────────
// Recovery manifest types — mirror manifest.rs.
// ──────────────────────────────────────────────────────────────────────

export interface VerifyStep {
  command: string;
  timeout_ms: number;
  max_wait_ms: number;
  poll_ms: number;
}

export interface RecoveryStep {
  id: string;
  title: string;
  why: string;
  command: string;
  timeout_ms: number;
  required: boolean;
  verify: VerifyStep | null;
}

export interface RecoveryManifest {
  schema_version: number;
  steps: RecoveryStep[];
}

// ──────────────────────────────────────────────────────────────────────
// Repair progress types — mirror repair.rs.
// ──────────────────────────────────────────────────────────────────────

export type StepState =
  | { kind: 'pending' }
  | { kind: 'running' }
  | { kind: 'done'; duration_ms: number }
  | { kind: 'failed'; detail: string; duration_ms: number }
  | { kind: 'skipped'; detail: string };

export interface StepProgress {
  id: string;
  title: string;
  state: StepState;
}

export type OverallRepairState =
  | { kind: 'not_started' }
  | { kind: 'running' }
  | { kind: 'completed'; duration_ms: number }
  | { kind: 'failed'; failed_step_id: string };

export interface RepairResult {
  steps: StepProgress[];
  overall: OverallRepairState;
  started_at: string;
  finished_at: string;
}

export type RepairEvent =
  | { type: 'started' }
  | { type: 'step_started'; step_id: string }
  | { type: 'step_done'; step_id: string; duration_ms: number }
  | { type: 'step_failed'; step_id: string; detail: string; duration_ms: number }
  | { type: 'step_skipped'; step_id: string; detail: string }
  | { type: 'completed'; duration_ms: number }
  | { type: 'failed'; failed_step_id: string };

// ──────────────────────────────────────────────────────────────────────
// Probe / StackStatus types — mirror probe.rs (subset; only fields the
// frontend reads). The full snapshot includes per-probe details which
// the diagnostics window will surface in a future milestone.
// ──────────────────────────────────────────────────────────────────────

export type OverallStatus =
  | 'green'
  | 'amber'
  | 'red'
  | 'grey'
  | 'notinstalled';

export interface StackStatus {
  overall: OverallStatus;
  headline: string;
  detail: string | null;
  last_probed_at: string;
}

// ──────────────────────────────────────────────────────────────────────
// Settings types — mirror settings.rs.
// ──────────────────────────────────────────────────────────────────────

export interface Settings {
  poll_interval_ms: number;
  launch_at_login: boolean;
  notify_on_state_change: boolean;
  notify_audible: boolean;
  hide_until_amber: boolean;
  auto_check_updates: boolean;
  last_update_check_at: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// Update types — mirror commands.rs UpdateInfo + UpdateAvailableEvent.
// ──────────────────────────────────────────────────────────────────────

export interface UpdateInfo {
  version: string;
  current_version: string;
  date: string | null;
  body: string | null;
}

/** Payload of the `update-available` Tauri event fired by the
 *  background poll loop in lib.rs::run_update_check_loop. */
export interface UpdateAvailableEvent {
  version: string;
  current_version: string;
  body: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// Command wrappers.
// ──────────────────────────────────────────────────────────────────────

export async function getRecoveryManifest(): Promise<RecoveryManifest> {
  return await invoke<RecoveryManifest>('get_recovery_manifest');
}

export async function startRepair(confirm: string): Promise<RepairResult> {
  return await invoke<RepairResult>('start_repair', { confirm });
}

// ──────────────────────────────────────────────────────────────────────
// v0.1.8 — Pull upstream updates.
//
// The manifest + result + per-step event shapes are the SAME as Repair
// Stack — both flows are sequential step chains. The Tauri event channel
// differs (`pull-progress` vs `repair-progress`) so the two UIs can
// listen independently without bleed-through.
// ──────────────────────────────────────────────────────────────────────

export async function getPullManifest(): Promise<RecoveryManifest> {
  return await invoke<RecoveryManifest>('get_pull_manifest');
}

export async function startPull(confirm: string): Promise<RepairResult> {
  return await invoke<RepairResult>('start_pull', { confirm });
}

export async function onPullProgress(
  cb: (event: RepairEvent) => void,
): Promise<UnlistenFn> {
  return await listen<RepairEvent>('pull-progress', (e) => cb(e.payload));
}

export async function getSettings(): Promise<Settings> {
  return await invoke<Settings>('get_settings');
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  return await invoke<Settings>('save_settings', { settings });
}

export async function getLogPath(): Promise<string | null> {
  return await invoke<string | null>('get_log_path');
}

export async function tailLog(lines: number): Promise<string> {
  return await invoke<string>('tail_log', { lines });
}

// ──────────────────────────────────────────────────────────────────────
// R1 — Pre-flight prereq probes for the Welcome window.
// (audit: assessments/2026-05-08-setup-journey-ux.md)
// ──────────────────────────────────────────────────────────────────────

/** One-click action a probe can suggest the Doctor perform. */
export type FixAction = { kind: 'launch_docker_app' };

export interface PrereqResult {
  /** Stable identifier — "git" | "node" | "docker" | "tailscale". */
  name: string;
  /** True iff the binary / app is present on disk. */
  installed: boolean;
  /** True iff `installed` AND meets the wizard's requirement
   *  (e.g. node ≥ 20, docker daemon reachable). The Welcome CTA is
   *  gated on every result having ok = true. */
  ok: boolean;
  /** Human-readable single-line status to render next to the row. */
  detail: string;
  /** Where to send the operator if they need to install. */
  install_url: string;
  /** Optional one-click fix the Doctor can perform. */
  fix_action: FixAction | null;
}

/** Run all four probes in parallel. Called on Welcome window mount,
 *  on Recheck, and after launch_docker_and_wait completes. */
export async function checkAllPrereqs(): Promise<PrereqResult[]> {
  return await invoke<PrereqResult[]>('check_all_prereqs');
}

/** Open Docker Desktop and poll for daemon readiness for up to 60s.
 *  Returns the final docker probe result. */
export async function launchDockerAndWait(): Promise<PrereqResult> {
  return await invoke<PrereqResult>('launch_docker_and_wait');
}

// ──────────────────────────────────────────────────────────────────────
// R.7 — Welcome window commands.
// ──────────────────────────────────────────────────────────────────────

export async function isFirstRun(): Promise<boolean> {
  return await invoke<boolean>('is_first_run');
}

export async function dismissWelcome(): Promise<void> {
  return await invoke<void>('dismiss_welcome');
}

/** Opens Terminal.app with `npx claw-setup` pre-staged. The operator
 *  must press Enter to actually run it — we don't auto-execute. */
export async function openSetupInTerminal(): Promise<void> {
  return await invoke<void>('open_setup_in_terminal');
}

export async function getCurrentVersion(): Promise<string> {
  return await invoke<string>('get_current_version');
}

/** Returns the most recent probe snapshot, or null if no probe has
 *  completed yet (the loop runs every poll_interval_ms). */
export async function getLastStatus(): Promise<StackStatus | null> {
  return await invoke<StackStatus | null>('get_last_status');
}

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  return await invoke<UpdateInfo | null>('check_for_updates');
}

/** Downloads + verifies + installs the available update + restarts.
 *  Resolves only after the new process is launching. Throws if no
 *  update is available or the download/verify fails. */
export async function installUpdateAndRestart(): Promise<void> {
  return await invoke<void>('install_update_and_restart');
}

/** Subscribe to background update detections. The poll loop fires
 *  this when `latest.json` reports a newer version than the running
 *  binary. The Settings window listens to surface a banner. */
export async function onUpdateAvailable(
  cb: (event: UpdateAvailableEvent) => void,
): Promise<UnlistenFn> {
  return await listen<UpdateAvailableEvent>('update-available', (e) => cb(e.payload));
}

// ──────────────────────────────────────────────────────────────────────
// Event subscription.
// ──────────────────────────────────────────────────────────────────────

export async function onRepairProgress(
  cb: (event: RepairEvent) => void,
): Promise<UnlistenFn> {
  return await listen<RepairEvent>('repair-progress', (e) => cb(e.payload));
}
