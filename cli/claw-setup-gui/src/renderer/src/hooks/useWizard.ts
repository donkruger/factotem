import { useCallback, useRef, useState } from 'react'

// Step order mirrors the CLI's W.1 (2026-05-08) execution order, with
// the Gemini blueprint PR 3 split of step 03 (configure-onecli) into
// two: `provider` (data-driven picker from providers.json) +
// `credentials` (data-driven per-provider key entry + OneCLI register).
//
// 00 → 01 → 02 → 03a → 03b → 04 → 05 → 06 → 09 → 07 → 08 → 10 → 11
//
// Why the rest of the order: steps 07 (register main group) and 08
// (open-DM config) require the orchestrator to be running, so step 09
// (service install) has to come before them. The CLI ids stay 00-11 —
// what changes is which one runs when.
export type StepId =
  | 'welcome' // 00 — Welcome
  | 'envCheck' // 01 — Check prereqs
  | 'install' // 02 — Install prereqs
  | 'provider' // 03a — Pick AI provider (PR 3, data-driven)
  | 'credentials' // 03b — Collect credential or detect local (PR 3, data-driven)
  | 'mounts' // 04 — Mounts allowlist
  | 'profile' // (was 00 in CLI; renamed for clarity — picks profile + assistant name)
  | 'container' // 05 — Build container
  // Add-agent only: choose between reusing the existing shared
  // WhatsApp account or pairing a new number for this agent
  // (v1.2.1-finish-blueprint § 2). Never appears in the first-run
  // sequence — it lives off STEPS[] and is goTo()'d into from
  // /agents/new on the dashboard.
  | 'pairingChoice'
  | 'whatsapp' // 06 — Pair WhatsApp
  | 'service' // 09 — Install service (precedes 07/08)
  | 'register' // 07 — Register main group
  | 'openmode' // 08 — Open-DM config
  | 'smoke' // 10 — Smoke test
  | 'ready' // 11 — Handoff to dashboard

// Visual ordering for the wizard. Profile (the CLI's step 00) runs
// after Welcome but before EnvCheck so the wizard knows whether the
// operator wants the full setup before probing the environment.
//
// `pairingChoice` is intentionally *not* in this array — it's an
// add-agent-only branch that CredentialsStep `goTo()`s when the
// state-store carries an add-agent hand-off flag. Keeping it off
// the linear path means first-run users see no extra step counter
// position and no flicker; the indicator's "Step N of M" stays
// honest for the common case. See useWizard's StepId comment +
// v1.2.1-finish-blueprint § 2.3.
export const STEPS: StepId[] = [
  'welcome',
  'profile',
  'envCheck',
  'install',
  'provider',
  'credentials',
  'mounts',
  'container',
  'whatsapp',
  'service',
  'register',
  'openmode',
  'smoke',
  'ready'
]

export const STEP_LABELS: Record<StepId, string> = {
  welcome: 'Welcome',
  profile: 'Profile',
  envCheck: 'Check',
  install: 'Install',
  provider: 'Provider',
  credentials: 'Credentials',
  mounts: 'Mounts',
  container: 'Container',
  pairingChoice: 'Pairing',
  whatsapp: 'WhatsApp',
  service: 'Service',
  register: 'Group',
  openmode: 'Open-DM',
  smoke: 'Smoke test',
  ready: 'Ready'
}

export function useWizard(initial: StepId = 'welcome') {
  const [current, setCurrent] = useState<StepId>(initial)
  const history = useRef<StepId[]>([])

  const goTo = useCallback((id: StepId) => {
    setCurrent((prev) => {
      history.current.push(prev)
      return id
    })
  }, [])

  const next = useCallback(() => {
    const idx = STEPS.indexOf(current)
    if (idx >= 0 && idx < STEPS.length - 1) goTo(STEPS[idx + 1])
  }, [current, goTo])

  const back = useCallback(() => {
    const prev = history.current.pop()
    if (prev) setCurrent(prev)
  }, [])

  return { current, goTo, next, back, steps: STEPS, labels: STEP_LABELS }
}
