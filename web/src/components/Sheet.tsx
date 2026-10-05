import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One line under the title. */
  description?: string;
  children: ReactNode;
  /** Buttons along the bottom edge, primary last. */
  footer?: ReactNode;
  /** Wider sheets for tables of results. */
  size?: 'medium' | 'large';
  /** False while the sheet must stay, as during a task: Escape then does nothing. */
  dismissible?: boolean;
}

/**
 * A modal sheet over the window. It uses the native dialog element, so Escape, focus trapping
 * and the inert background come from the browser. A sheet's primary replaces the window's.
 */
export function Sheet({ open, onClose, title, description, children, footer, size = 'medium', dismissible = true }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // Counts closes by the browser, so a sheet whose owner keeps it open is shown again.
  const [closes, setCloses] = useState(0);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open, closes]);

  return (
    <dialog
      ref={dialog}
      className={`sheet ${size}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        if (!dismissible) e.preventDefault();
      }}
      onClose={() => {
        setCloses((n) => n + 1);
        onClose();
      }}
      onClick={(e) => e.target === dialog.current && dismissible && onClose()}
    >
      <div className="sheet-body">
        <header className="sheet-head">
          <h2 id={titleId} className="sheet-title">
            {title}
          </h2>
          {description && <p className="sheet-description">{description}</p>}
        </header>
        {children}
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}
