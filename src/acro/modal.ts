/**
 * Shows a dialog's backdrop as a modal, the way <dialog>.showModal() does:
 * everything else on the page goes inert (Tab, clicks and screen readers
 * can't reach behind it), focus moves into the dialog, and once the backdrop
 * is removed focus goes back to whatever opened it. Dialogs can stack: one
 * opened over another makes only the one below inert.
 */

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Layers that work over dialogs: menus a dialog opens, toasts, the file
 *  picker's input (app.html) */
const ABOVE = '#popover-layer, #toasts, #open-input';

export function showModal(backdrop: HTMLElement): void {
  const opener = document.activeElement as HTMLElement | null;
  const behind = [...document.body.children].filter(
    (el) => el !== backdrop && !el.hasAttribute('inert') && !el.matches(ABOVE)
  );
  for (const el of behind) el.setAttribute('inert', '');
  backdrop
    .querySelector('[role="dialog"], [role="alertdialog"]')
    ?.setAttribute('aria-modal', 'true');
  document.body.append(backdrop);

  // Callers that focus a field or button of their own do so right after this
  queueMicrotask(() => {
    if (backdrop.isConnected && !backdrop.contains(document.activeElement))
      backdrop.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  });

  const closed = new MutationObserver(() => {
    if (backdrop.isConnected) return;
    closed.disconnect();
    for (const el of behind) el.removeAttribute('inert');
    // Only when focus went down with the dialog: an action that moved it on
    // purpose keeps it there
    const now = document.activeElement;
    if ((!now || now === document.body) && opener?.isConnected) opener.focus();
  });
  closed.observe(document.body, { childList: true });
}
