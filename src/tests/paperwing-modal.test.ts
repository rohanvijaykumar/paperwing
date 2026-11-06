import { beforeEach, describe, expect, it } from 'vitest';
import { showModal } from '../acro/modal';

/** Lets the focus microtask and the removal observer run */
const settle = () => new Promise((r) => setTimeout(r));

function makeDialog(...buttons: string[]) {
  const backdrop = document.createElement('div');
  backdrop.className = 'dlg-backdrop';
  const box = document.createElement('div');
  box.setAttribute('role', 'dialog');
  for (const label of buttons) {
    const b = document.createElement('button');
    b.textContent = label;
    box.append(b);
  }
  backdrop.append(box);
  return { backdrop, box, buttons: [...box.querySelectorAll('button')] };
}

describe('showModal', () => {
  let app: HTMLElement;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    document.body.innerHTML = '<main id="app"><button>Open</button></main>';
    app = document.getElementById('app')!;
    opener = app.querySelector('button')!;
    opener.focus();
  });

  it('makes the page behind inert, marks the dialog modal and focuses into it', async () => {
    const d = makeDialog('Close', 'OK');
    showModal(d.backdrop);
    await settle();
    expect(app.hasAttribute('inert')).toBe(true);
    expect(d.box.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(d.buttons[0]);
  });

  it('leaves the menu and toast layers usable over the dialog', async () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="popover-layer"></div><div id="toasts"></div>'
    );
    showModal(makeDialog('OK').backdrop);
    await settle();
    expect(
      document.getElementById('popover-layer')!.hasAttribute('inert')
    ).toBe(false);
    expect(document.getElementById('toasts')!.hasAttribute('inert')).toBe(
      false
    );
  });

  it("keeps the focus the dialog's own code chose", async () => {
    const d = makeDialog('Cancel', 'Save');
    showModal(d.backdrop);
    d.buttons[1].focus();
    await settle();
    expect(document.activeElement).toBe(d.buttons[1]);
  });

  it('returns focus to the opener and re-enables the page when closed', async () => {
    const d = makeDialog('Close');
    showModal(d.backdrop);
    await settle();
    d.backdrop.remove();
    await settle();
    expect(app.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("doesn't take focus back from something the closing action focused", async () => {
    const other = document.createElement('input');
    app.append(other);
    const d = makeDialog('Go');
    showModal(d.backdrop);
    await settle();
    d.backdrop.remove();
    app.removeAttribute('inert'); // as the observer would, so it can be focused
    other.focus();
    await settle();
    expect(document.activeElement).toBe(other);
  });

  it('stacks: closing the top dialog re-enables and refocuses the one below', async () => {
    const lower = makeDialog('Delete');
    showModal(lower.backdrop);
    await settle();
    const upper = makeDialog('Cancel');
    showModal(upper.backdrop);
    await settle();
    expect(lower.backdrop.hasAttribute('inert')).toBe(true);
    expect(app.hasAttribute('inert')).toBe(true);

    upper.backdrop.remove();
    await settle();
    expect(lower.backdrop.hasAttribute('inert')).toBe(false);
    expect(app.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(lower.buttons[0]);

    lower.backdrop.remove();
    await settle();
    expect(app.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});
