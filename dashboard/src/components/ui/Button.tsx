import { ButtonHTMLAttributes, forwardRef } from 'react';

type Variant = 'primary' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', className = '', ...props }, ref) => {
    const base =
      'inline-flex items-center justify-center gap-2 rounded-pill px-6 py-3 text-sm font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-[var(--color-focus-ring)] focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';
    const variants = {
      primary:
        'bg-[var(--color-ink)] text-[var(--color-bg)] hover:-translate-y-px hover:shadow-[var(--shadow-1)]',
      ghost:
        'border border-[var(--color-hairline)] text-[var(--color-ink)] hover:bg-[var(--color-bg-subtle)]',
    };
    return (
      <button
        ref={ref}
        className={`${base} ${variants[variant]} ${className}`}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
