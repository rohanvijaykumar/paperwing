/**
 * What's new shows docs/RELEASE_NOTES.md, built into the app: the notes
 * must be this version's, or the app would offer last version's news.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseNotes } from '../acro/whats-new';

const version: string = JSON.parse(
  readFileSync(resolve(__dirname, '../../desktop/package.json'), 'utf8')
).version;

describe("what's new", () => {
  it("has this version's release notes", () => {
    const notes = releaseNotes(version);
    expect(
      notes,
      `docs/RELEASE_NOTES.md is for Paperwing ${version}`
    ).not.toBeNull();
    expect(notes!.lead.length).toBeGreaterThan(0);
    expect(notes!.body.querySelectorAll('h3').length).toBeGreaterThan(0);
    expect(notes!.body.querySelectorAll('li').length).toBeGreaterThan(0);
  });

  it('leaves out how to install, and shows no Markdown', () => {
    const text = releaseNotes(version)!.body.textContent ?? '';
    expect(text).not.toMatch(/update themselves|\*\*|\]\(|<!--/);
  });

  it('links only to https pages, opening outside the app', () => {
    for (const a of releaseNotes(version)!.body.querySelectorAll('a')) {
      expect(a.href).toMatch(/^https:\/\//);
      expect(a.target).toBe('_blank');
    }
  });

  it("shows nothing for another version's notes", () => {
    expect(releaseNotes('0.0.1')).toBeNull();
  });
});
