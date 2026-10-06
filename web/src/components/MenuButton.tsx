import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { EllipsisVertical } from 'lucide-react';

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Drawn with a hairline above it, to set it apart from the items before. */
  separated?: boolean;
  title?: string;
}

interface Props {
  /** Accessible name of the button and its menu. */
  label: string;
  items: MenuItem[];
  buttonRef?: Ref<HTMLButtonElement>;
}

/**
 * An icon button that opens a menu of actions below it. Arrow keys, Home and End move through
 * the enabled items; Escape closes it and returns focus to the button.
 */
export function MenuButton({ label, items, buttonRef }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // Which item gets focus once the menu has rendered.
  const [initialFocus, setInitialFocus] = useState<'first' | 'last' | null>(null);

  const enabledItems = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];

  useEffect(() => {
    if (!open || initialFocus === null) return;
    const all = enabledItems();
    (initialFocus === 'first' ? all[0] : all[all.length - 1])?.focus();
    setInitialFocus(null);
  }, [open, initialFocus]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const show = (focus: 'first' | 'last') => {
    setOpen(true);
    setInitialFocus(focus);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onButtonKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      show(e.key === 'ArrowDown' ? 'first' : 'last');
    }
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = enabledItems();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === 'ArrowDown') next = all[(at + 1) % all.length];
    else if (e.key === 'ArrowUp') next = all[(at - 1 + all.length) % all.length];
    else if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    } else if (e.key === 'Tab') {
      setOpen(false);
      return;
    } else return;
    e.preventDefault();
    next?.focus();
  };

  if (items.length === 0) return null;

  return (
    <div ref={root} className="menu-anchor">
      <button
        ref={(el) => {
          button.current = el;
          if (typeof buttonRef === 'function') buttonRef(el);
          else if (buttonRef) buttonRef.current = el;
        }}
        type="button"
        className="icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : show('first'))}
        onKeyDown={onButtonKeyDown}
      >
        <EllipsisVertical size={18} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {open && (
        <div ref={menu} id={menuId} role="menu" aria-label={label} className="menu" onKeyDown={onMenuKeyDown}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={item.separated ? 'menu-item separated' : 'menu-item'}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {item.icon}
              <span className="menu-label">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
