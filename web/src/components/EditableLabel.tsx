import { useEffect, useRef, useState } from 'react';

interface Props {
  value: string;
  placeholder?: string;
  className?: string;
  title?: string;
  onCommit: (next: string) => void;
}

export function EditableLabel({ value, placeholder, className, title, onCommit }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const start = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(value);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    if (draft !== value) onCommit(draft);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`editable-input ${className ?? ''}`}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
    );
  }

  return (
    <span className={className} title={title} onDoubleClick={start}>
      {value || <span style={{ color: 'var(--muted)' }}>{placeholder}</span>}
    </span>
  );
}
