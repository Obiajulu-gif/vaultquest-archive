import type { FC, ReactNode } from "react";
import { useEffect, useCallback, useRef } from "react";

export interface ModalProps {
  children?: ReactNode;
  onClose: () => void;
  className?: string;
  /**
   * Accessible label for the dialog. Required for screen readers when no
   * heading is provided via `aria-labelledby`.
   */
  ariaLabel?: string;
  /** id of the element labelling the dialog (e.g. the modal heading). */
  ariaLabelledBy?: string;
  /** id of the element describing the dialog. */
  ariaDescribedBy?: string;
}

/**
 * Accessible dialog (#64).
 *
 * Improvements over the original implementation:
 *  - `role="dialog"` + `aria-modal="true"` so assistive tech treats it as a modal
 *  - Initial focus moved to the first focusable element inside the dialog
 *  - Focus trap — Tab and Shift+Tab cycle within the dialog only
 *  - Returns focus to the previously focused element when the dialog closes
 *  - Escape still closes, click-on-backdrop still closes
 *  - Close button is keyboard-reachable with a visible focus ring
 */
const FOCUSABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex]:not([tabindex="-1"]), [contenteditable]';

const Modal: FC<ModalProps> = ({
  children,
  onClose,
  className = "",
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const handleEsc = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    },
    [onClose],
  );

  // Focus-trap: keep Tab/Shift+Tab inside the dialog
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;

    const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    if (!active || !root.contains(active)) {
      event.preventDefault();
      if (event.shiftKey) {
        last.focus();
      } else {
        first.focus();
      }
      return;
    }

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    // Capture the previously focused element so we can restore it on close
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    window.addEventListener("keydown", handleEsc);
    window.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";

    // Move focus into the dialog
    requestAnimationFrame(() => {
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (focusable ?? root).focus();
    });

    return () => {
      window.removeEventListener("keydown", handleEsc);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      // Restore focus to the trigger that opened the dialog
      previouslyFocusedRef.current?.focus();
    };
  }, [handleEsc, handleKeyDown]);

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-md flex justify-center items-center z-[100] p-4 animate-in fade-in duration-300"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabelledBy ? undefined : ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        tabIndex={-1}
        className={`bg-[#1A0505] border border-red-900/40 rounded-2xl shadow-2xl max-w-md w-full relative overflow-hidden animate-in zoom-in-95 duration-300 outline-none max-h-[90vh] flex flex-col ${className}`}
      >
        <div className="p-6 sm:p-8 overflow-y-auto max-h-[calc(90vh-3rem)]">{children}</div>
        <button
          type="button"
          className="absolute top-4 right-4 text-gray-500 hover:text-white transition-colors p-2 hover:bg-white/10 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505] z-10"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default Modal;
