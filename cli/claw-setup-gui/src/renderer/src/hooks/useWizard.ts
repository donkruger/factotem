import { useCallback, useRef, useState } from 'react'

// Step order mirrors the CLI's W.1 (2026-05-08) execution order:
// 00 → 01 → 02 → 03 → 04 → 05 → 06 → 09 → 07 → 08 → 10 → 11
//
// Why this order: steps 07 (register main group) and 08 (open-DM
// config) require the orchestrator to be running, so step 09 (service
// install) has to come before them. The CLI ids stay 00-11 — what
// changes is which one runs when.
export type StepId =
  | 'welcome' // 00 — Welcome
  | 'envCheck' // 01 — Check prereqs
  | 'install' // 02 — Install prereqs
  | 'onecli' // 03 — Configure OneCLI
  | 'mounts' // 04 — Mounts allowlist
  | 'profile' // (was 00 in CLI; renamed for clarity — picks profile + assistant name)
  | 'container' // 05 — Build container
  | 'whatsapp' // 06 — Pair WhatsApp
  | 'service' // 09 — Install service (precedes 07/08)
  | 'register' // 07 — Register main group
  | 'openmode' // 08 — Open-DM config
  | 'smoke' // 10 — Smoke test
  | 'ready' // 11 — Handoff to dashboard

// Visual ordering for the wizard. Profile (the CLI's step 00) runs
// after Welcome but before EnvCheck so the wizard knows whether the
// operator wants the full setup before probing the environment.
export const STEPS: StepId[] = [
  'welcome',
  'profile',
  'envCheck',
  'install',
  'onecli',
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
  onecli: 'OneCLI',
  mounts: 'Mounts',
  container: 'Container',
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
