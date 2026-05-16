interface IconProps {
  size?: number;
  className?: string;
}

export function EyeIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function EyeOffIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10.6 6.1A10.6 10.6 0 0 1 12 6c6.5 0 10 6 10 6a17.6 17.6 0 0 1-3.1 3.9M6.1 7.7C3.7 9.6 2 12 2 12s3.5 7 10 7c1.5 0 2.8-.3 4-.8"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M9.5 9.6a3 3 0 0 0 4.2 4.2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

export function ChevronIcon({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms' }}
    >
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

export function PlusIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
