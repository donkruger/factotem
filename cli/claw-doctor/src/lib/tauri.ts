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
// Settings types — mirror settings.rs.
// ──────────────────────────────────────────────────────────────────────

export interface Settings {
  poll_interval_ms: number;
  launch_at_login: boolean;
  notify_on_state_change: boolean;
  notify_audible: boolean;
  hide_until_amber: boolean;
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
// Event subscription.
// ──────────────────────────────────────────────────────────────────────

export async function onRepairProgress(
  cb: (event: RepairEvent) => void,
): Promise<UnlistenFn> {
  return await listen<RepairEvent>('repair-progress', (e) => cb(e.payload));
}
