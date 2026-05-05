import {
  AlertCircle,
  AlertTriangle,
  ExternalLink,
  Info,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatRelativeTime } from '@/lib/format';
import { type Alert, type AlertSeverity } from '@/lib/nanoclaw';

import { RestartStackButton } from './RestartStackButton';

interface AlertCardProps {
  alert: Alert;
  /** Forwarded from AlertsResponse.restart_stack_enabled. */
  restartStackEnabled: boolean;
  /** Called after a successful Restart Stack action so the list re-polls. */
  onRestartCompleted?: () => void;
}

interface SeverityStyle {
  border: string;
  iconColor: string;
  icon: LucideIcon;
  label: string;
  badge: 'error' | 'warning' | 'neutral';
}

const SEVERITY_STYLES: Record<AlertSeverity, SeverityStyle> = {
  critical: {
    border: 'border-l-4 border-l-red-500 dark:border-l-red-400',
    iconColor: 'text-red-600 dark:text-red-400',
    icon: AlertTriangle,
    label: 'Critical',
    badge: 'error',
  },
  warning: {
    border: 'border-l-4 border-l-amber-500 dark:border-l-amber-400',
    iconColor: 'text-amber-600 dark:text-amber-400',
    icon: AlertCircle,
    label: 'Warning',
    badge: 'warning',
  },
  info: {
    border:
      'border-l-4 border-l-[var(--color-hairline)] dark:border-l-[var(--color-hairline)]',
    iconColor: 'text-[var(--color-ink-muted)]',
    icon: Info,
    label: 'Info',
    badge: 'neutral',
  },
};

/**
 * Single Round-7-catalogue alert. Severity drives the left-border accent,
 * the icon, and the badge variant. Recovery actions (URL link, restart
 * stack button) are rendered in the action row only when the alert
 * supplies them.
 */
export function AlertCard({
  alert,
  restartStackEnabled,
  onRestartCompleted,
}: AlertCardProps) {
  const style = SEVERITY_STYLES[alert.severity];
  const Icon = style.icon;
  const showRestart = alert.recovery_action === 'restart_stack';
  const showRecoveryLink = !!alert.recovery_url;

  return (
    <Card className={style.border}>
      <div className="flex items-start gap-3">
        <Icon
          className={`mt-0.5 h-5 w-5 flex-shrink-0 ${style.iconColor}`}
          aria-hidden="true"
        />
        <div className="flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-medium text-[var(--color-ink)]">
              {alert.title}
            </h2>
            <Badge variant={style.badge}>{style.label}</Badge>
          </div>

          <p className="text-sm text-[var(--color-ink)]">{alert.detail}</p>

          {alert.recommendation && (
            <p className="text-sm italic text-[var(--color-ink-muted)]">
              {alert.recommendation}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-3">
              {showRecoveryLink && (
                <a
                  href={alert.recovery_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-[var(--color-ink)] underline hover:no-underline"
                >
                  View recovery procedure
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              )}
              {showRestart && (
                <RestartStackButton
                  enabled={restartStackEnabled}
                  onCompleted={onRestartCompleted}
                />
              )}
            </div>
            <time
              dateTime={alert.detected_at}
              className="text-xs text-[var(--color-ink-muted)]"
            >
              {formatRelativeTime(alert.detected_at)}
            </time>
          </div>
        </div>
      </div>
    </Card>
  );
}
