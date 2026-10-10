import type { ReactNode } from 'react';
import { Button, type ButtonProps } from './button';

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'size' | 'aria-label'> {
  /** The accessible name. An icon has no text, so the name is required (contract C12: a prop, never a literal). */
  readonly label: string;
  readonly size?: 'default' | 'sm';
  /** The icon. It is hidden from assistive technology; the label names the button. */
  readonly children: ReactNode;
}

export function IconButton({
  label,
  size = 'default',
  variant = 'ghost',
  children,
  ...props
}: IconButtonProps) {
  return (
    <Button
      {...props}
      variant={variant}
      size={size === 'sm' ? 'icon-sm' : 'icon'}
      aria-label={label}
    >
      <span aria-hidden="true" className="inline-flex">
        {children}
      </span>
    </Button>
  );
}
