import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

// Stack of close callbacks for currently-open dialogs, topmost last. Lets the
// hardware back button close the active dialog instead of navigating the page
// underneath it away (dialogs are local component state, not router history).
const openDialogStack: (() => void)[] = [];

export function closeTopDialog(): boolean {
  const close = openDialogStack[openDialogStack.length - 1];
  if (close) {
    close();
    return true;
  }
  return false;
}

const DialogTitleIdContext = React.createContext<string | undefined>(undefined);
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Dialog({ open, onOpenChange, children }: DialogProps) {
  const titleId = React.useId();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<() => void>(() => {});

  React.useEffect(() => {
    if (!open) return;
    const close = () => onOpenChange(false);
    closeRef.current = close;
    openDialogStack.push(close);
    return () => {
      const idx = openDialogStack.indexOf(close);
      if (idx !== -1) openDialogStack.splice(idx, 1);
    };
  }, [open, onOpenChange]);

  // move focus in, keep Tab inside, and hand focus back on close
  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // the panel itself, not the first input, so phones don't pop the keyboard on every dialog
    if (panel && !panel.contains(document.activeElement)) panel.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      // only the topmost dialog reacts
      if (openDialogStack[openDialogStack.length - 1] !== closeRef.current || !panelRef.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === 'Tab') {
        const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className="fixed inset-0 bg-black/80 animate-in fade-in-0"
        onClick={() => onOpenChange(false)}
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="relative w-full max-w-lg max-h-[85vh] overflow-auto rounded-lg bg-background p-6 shadow-lg animate-in fade-in-0 zoom-in-95 focus:outline-none"
          onClick={e => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label="Close"
            className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
          </button>
          <DialogTitleIdContext.Provider value={titleId}>
            {children}
          </DialogTitleIdContext.Provider>
        </div>
      </div>
    </div>,
    document.body
  );
}

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left mb-4', className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  const titleId = React.useContext(DialogTitleIdContext);
  return <h2 id={titleId} className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export { Dialog, DialogHeader, DialogTitle, DialogDescription };
