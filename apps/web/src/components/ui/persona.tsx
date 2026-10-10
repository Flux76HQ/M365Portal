import { cn } from '../../lib/cn';

const SIZES = {
  sm: 'size-6 text-caption',
  md: 'size-8 text-body-sm',
  lg: 'size-10 text-body',
} as const;

export interface PersonaProps {
  /** One to three letters, already computed by the caller (packages/shared: initials). */
  readonly initials: string;
  /** The accessible name: who or what this is ("Alice Example", "Contoso"). */
  readonly label: string;
  readonly size?: keyof typeof SIZES;
  readonly className?: string;
}

/**
 * A round mark with initials (a person, the organisation). It is the accent pair, whose contrast the
 * accent derivation guarantees for any brand colour (FR-A-101). The initials are decoration; the
 * label names it. A circle is one of the three uses of the full radius (plan 10.3).
 */
export function Persona({ initials, label, size = 'md', className }: PersonaProps) {
  return (
    <span
      role="img"
      aria-label={label}
      data-slot="persona"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-on-accent select-none forced-colors:border',
        SIZES[size],
        className,
      )}
    >
      <span aria-hidden="true">{initials}</span>
    </span>
  );
}
