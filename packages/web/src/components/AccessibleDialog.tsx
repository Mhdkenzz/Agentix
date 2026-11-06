import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Shared keyboard and screen-reader behavior for the app's modal dialogs. */
export function AccessibleDialog({
  title,
  children,
  onClose,
  closeDisabled = false,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  closeDisabled?: boolean;
  className?: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const disabledRef = useRef(closeDisabled);
  closeRef.current = onClose;
  disabledRef.current = closeDisabled;
  const titleId = `dialog-title-${useId()}`;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const root = dialog.current;
    const focusable = () => [...(root?.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter(element => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
    (focusable()[0] ?? root)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (!disabledRef.current) {
          event.preventDefault();
          closeRef.current();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); root?.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget && !closeDisabled) onClose();
    }}>
      <div ref={dialog} className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
