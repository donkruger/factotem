import { HTMLAttributes, forwardRef, createElement, ElementType } from 'react';

interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Underlying element. Defaults to `div`. */
  as?: ElementType;
}

export const Card = forwardRef<HTMLElement, CardProps>(
  ({ as = 'div', className = '', children, ...props }, ref) => {
    const base =
      'rounded-2xl border border-[var(--color-hairline)] bg-[var(--color-bg)] p-6 transition-shadow duration-200 hover:shadow-[var(--shadow-1)]';
    return createElement(
      as,
      {
        ref,
        className: `${base} ${className}`,
        ...props,
      },
      children,
    );
  },
);
Card.displayName = 'Card';
