import { beforeEach, describe, expect, it } from 'vitest';
import { openDropdown, showsChoice } from '../acro/dropdowns';

/** Lets the observer run */
const settle = () => new Promise((r) => setTimeout(r));

const options = (...labels: string[]) =>
  labels.map((l) => {
    const o = document.createElement('option');
    o.value = l;
    o.textContent = l;
    return o;
  });

describe('dropdowns', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('gives a dropdown made later the button that shows its choice', async () => {
    const s = document.createElement('select');
    s.className = 'pref-select';
    s.append(...options('Color', 'Grayscale'));
    document.body.append(s);
    await settle();
    const button = s.querySelector(':scope > button');
    expect(button?.firstElementChild?.tagName.toLowerCase()).toBe(
      'selectedcontent'
    );
    expect(s.options.length).toBe(2);
  });

  it('gives it back when the options are replaced', async () => {
    const s = document.createElement('select');
    s.className = 'pref-select';
    document.body.append(s);
    await settle();
    s.replaceChildren(...options('Flatbed', 'Document feeder'));
    await settle();
    expect(s.querySelectorAll(':scope > button').length).toBe(1);
    expect(s.firstElementChild?.tagName).toBe('BUTTON');
  });

  it('adds it once, and leaves other selects alone', async () => {
    const mine = document.createElement('select');
    mine.className = 'pref-select';
    showsChoice(mine);
    showsChoice(mine);
    expect(mine.querySelectorAll('button').length).toBe(1);
    const other = document.createElement('select');
    other.append(...options('a'));
    document.body.append(other);
    await settle();
    expect(other.querySelector('button')).toBeNull();
  });

  it('a key from outside a dropdown is not from an open list', () => {
    const b = document.createElement('button');
    document.body.append(b);
    expect(openDropdown(b)).toBeNull();
    expect(openDropdown(null)).toBeNull();
  });
});
