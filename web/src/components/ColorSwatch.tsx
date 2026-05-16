import { useEffect, useRef, useState } from 'react';
import { GROUP_COLORS } from '../types';

interface Props {
  color: string;
  onChange: (color: string) => void;
}

export function ColorSwatch({ color, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="color-swatch-wrap" ref={ref}>
      <button
        className="color-swatch"
        style={{ background: color }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Group color"
      />
      {open && (
        <div className="color-popover" onClick={(e) => e.stopPropagation()}>
          {GROUP_COLORS.map((c) => (
            <button
              key={c}
              className={`color-dot ${c === color ? 'active' : ''}`}
              style={{ background: c }}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
