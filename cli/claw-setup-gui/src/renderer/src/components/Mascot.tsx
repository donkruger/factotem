interface Props {
  state?: 'idle' | 'loading' | 'success' | 'error'
  size?: number
}

// Placeholder mascot — re-themed for the Factotem light-mode palette.
// Warm orange (--color-accent #ff7a3a) as the base fill, near-black ink
// for facial features, no glow filter (we're Apple-flat now).
//
// This is intentionally a placeholder; the production version should be
// a commissioned illustration with four states (idle / loading /
// success / error). The DMG icon and DMG background image both need
// the real mascot before v1 release. See claw-setup-gui/CLAUDE.md
// § "Future work".
export function Mascot({ state = 'idle', size = 140 }: Props) {
  const fill =
    state === 'success'
      ? 'var(--color-success)'
      : state === 'error'
        ? 'var(--color-error)'
        : 'var(--color-accent)'

  const fillSoft =
    state === 'success'
      ? 'rgba(16, 185, 129, 0.18)'
      : state === 'error'
        ? 'rgba(220, 38, 38, 0.18)'
        : 'var(--color-accent-soft)'

  return (
    <div style={{ width: size, height: size }}>
      <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        {/* Soft background halo */}
        <circle cx="100" cy="100" r="78" fill={fillSoft} />

        {/* Left claw */}
        <ellipse cx="48" cy="100" rx="22" ry="14" fill={fill} />
        <ellipse cx="42" cy="92" rx="10" ry="6" fill={fill} />
        <ellipse cx="42" cy="108" rx="10" ry="6" fill={fill} />

        {/* Right claw */}
        <ellipse cx="152" cy="100" rx="22" ry="14" fill={fill} />
        <ellipse cx="158" cy="92" rx="10" ry="6" fill={fill} />
        <ellipse cx="158" cy="108" rx="10" ry="6" fill={fill} />

        {/* Connecting arms */}
        <path
          d="M 65 100 Q 85 90 100 100 Q 115 90 135 100"
          fill="none"
          stroke={fill}
          strokeWidth="6"
          strokeLinecap="round"
          opacity="0.6"
        />

        {/* Body */}
        <ellipse cx="100" cy="110" rx="34" ry="28" fill={fill} />

        {/* Eyes — near-black ink, matches the dashboard's foreground colour */}
        <circle cx="90" cy="102" r="4" fill="var(--color-ink)" />
        <circle cx="110" cy="102" r="4" fill="var(--color-ink)" />
        <circle cx="91" cy="101" r="1.5" fill="var(--color-bg)" />
        <circle cx="111" cy="101" r="1.5" fill="var(--color-bg)" />

        {/* Smile */}
        <path
          d="M 92 118 Q 100 122 108 118"
          fill="none"
          stroke="var(--color-ink)"
          strokeWidth="2"
          strokeLinecap="round"
        />

        {/* Antennae */}
        <line
          x1="92"
          y1="82"
          x2="86"
          y2="68"
          stroke={fill}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <line
          x1="108"
          y1="82"
          x2="114"
          y2="68"
          stroke={fill}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="86" cy="68" r="2.5" fill={fill} />
        <circle cx="114" cy="68" r="2.5" fill={fill} />

        {/* Loading state — small spinning ring overlay */}
        {state === 'loading' && (
          <g>
            <circle
              cx="100"
              cy="100"
              r="86"
              fill="none"
              stroke={fill}
              strokeWidth="3"
              strokeDasharray="40 200"
              strokeLinecap="round"
              opacity="0.7"
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 100 100"
                to="360 100 100"
                dur="1.2s"
                repeatCount="indefinite"
              />
            </circle>
          </g>
        )}
      </svg>
    </div>
  )
}
