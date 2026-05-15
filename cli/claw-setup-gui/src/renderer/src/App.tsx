import { useEffect, useState } from 'react'
import { useWizard } from './hooks/useWizard'
import { useElectronAPI } from './hooks/useElectronAPI'
import { StepIndicator } from './components/StepIndicator'
import { WelcomeStep } from './steps/WelcomeStep'
import { ProfileStep } from './steps/ProfileStep'
import { EnvCheckStep } from './steps/EnvCheckStep'
import { InstallStep } from './steps/InstallStep'
import { ProviderStep } from './steps/ProviderStep'
import { CredentialsStep } from './steps/CredentialsStep'
import { PairingChoiceStep } from './steps/PairingChoiceStep'
import { MountsStep } from './steps/MountsStep'
import { ContainerStep } from './steps/ContainerStep'
import { WhatsAppStep } from './steps/WhatsAppStep'
import { ServiceStep } from './steps/ServiceStep'
import { RegisterGroupStep } from './steps/RegisterGroupStep'
import { OpenModeStep } from './steps/OpenModeStep'
import { SmokeStep } from './steps/SmokeStep'
import { ReadyStep } from './steps/ReadyStep'

export default function App() {
  const { current, next, back, goTo, steps, labels } = useWizard()
  const api = useElectronAPI()
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    if (!api) return
    void api.app.version().then(setVersion)
  }, [api])

  // Deep-link support. When loaded with #<stepId> in the URL (set by
  // main process's loadWizard(stepHint)), jump to that step. Lets the
  // dashboard's subsystem cards link directly to the relevant part of
  // the wizard. Validates against the known step list so a malformed
  // hash can't navigate to arbitrary state.
  useEffect(() => {
    const raw = window.location.hash.replace(/^#/, '')
    if (!raw) return
    if (steps.includes(raw as (typeof steps)[number])) {
      goTo(raw as (typeof steps)[number])
    }
    // Clear the hash so re-mounts (HMR, internal navigation) don't
    // keep teleporting back to the deep-linked step.
    window.history.replaceState(null, '', window.location.pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!api) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-sm"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        Loading…
      </div>
    )
  }

  return (
    <>
      {/* Draggable strip that sits in place of the OS title bar.
          The window itself runs chrome-less (titleBarStyle hiddenInset
          on macOS, hidden + overlay on Windows — see main/index.ts),
          so we provide the drag affordance ourselves and keep the
          cream wizard panel flush against the window's top edge.
          Padding reserves the platform-specific button zones (80 px on
          the left for macOS traffic lights, 140 px on the right for the
          Windows min/max/close overlay) so any header content placed
          inside this strip in future cannot collide with them. */}
      <div className="title-bar" aria-hidden="true" />

      {current !== 'welcome' && (
        <StepIndicator steps={steps} labels={labels} current={current} />
      )}

      <main className="flex-1 flex flex-col relative z-10 min-h-0 overflow-y-auto">
        {current === 'welcome' && (
          <WelcomeStep onNext={next} onJump={goTo} />
        )}
        {current === 'profile' && <ProfileStep onNext={next} onBack={back} />}
        {current === 'envCheck' && <EnvCheckStep onNext={next} onBack={back} />}
        {current === 'install' && <InstallStep onNext={next} onBack={back} />}
        {current === 'provider' && <ProviderStep onNext={next} onBack={back} />}
        {current === 'credentials' && (
          <CredentialsStep onNext={next} onJump={goTo} onBack={back} />
        )}
        {current === 'pairingChoice' && (
          <PairingChoiceStep onJump={goTo} onBack={back} />
        )}
        {current === 'mounts' && <MountsStep onNext={next} onBack={back} />}
        {current === 'container' && <ContainerStep onNext={next} onBack={back} />}
        {current === 'whatsapp' && <WhatsAppStep onNext={next} onBack={back} />}
        {current === 'service' && <ServiceStep onNext={next} onBack={back} />}
        {current === 'register' && <RegisterGroupStep onNext={next} onBack={back} />}
        {current === 'openmode' && <OpenModeStep onNext={next} onBack={back} />}
        {current === 'smoke' && <SmokeStep onNext={next} onBack={back} />}
        {current === 'ready' && <ReadyStep onBack={back} />}
      </main>

      <footer
        className="flex items-center justify-between px-6 py-2.5 text-[10px] uppercase relative z-10"
        style={{
          color: 'var(--color-ink-dim)',
          letterSpacing: 'var(--tracking-caption)',
          borderTop: '1px solid var(--color-hairline)',
          background: 'var(--color-bg)'
        }}
      >
        <span>NanoClaw Setup · v{version || '0.1.0'}</span>
        {current !== 'ready' && (
          <button
            type="button"
            onClick={() => goTo('ready')}
            className="hover:underline transition-colors"
            style={{ color: 'var(--color-ink-dim)' }}
          >
            skip to end
          </button>
        )}
      </footer>
    </>
  )
}
