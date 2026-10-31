/**
 * What's new in this version: the release notes published with it on
 * GitHub (docs/RELEASE_NOTES.md), built into the app so they show offline.
 * The notes stop at the "end of the notes shown in the app" marker (what
 * follows is how to install, which doesn't belong in the app).
 */
import notes from '../../docs/RELEASE_NOTES.md?raw';

const END = '<!-- end of the notes shown in the app -->';

/** The notes, if they're this version's */
export function releaseNotes(
  version: string
): { lead: string; body: HTMLElement } | null {
  const text = notes.split(END)[0].replace(/\r\n/g, '\n');
  const title = /^## Paperwing (\S+)/m.exec(text);
  if (title?.[1] !== version) return null;
  const blocks = text
    .slice(title.index + title[0].length)
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const body = document.createElement('div');
  let lead = '';
  let list: HTMLUListElement | null = null;
  for (const block of blocks) {
    if (block.startsWith('### ')) {
      list = null;
      const h = document.createElement('h3');
      h.textContent = block.slice(4);
      body.append(h);
      continue;
    }
    if (block.startsWith('- ')) {
      list ??= body.appendChild(document.createElement('ul'));
      // Each item starts with "- "; its lines go on, indented
      for (const item of block.split(/\n(?=- )/)) {
        const li = document.createElement('li');
        li.append(...inline(item.slice(2).replace(/\n\s+/g, ' ')));
        list.append(li);
      }
      continue;
    }
    list = null;
    const line = block.replace(/\n\s*/g, ' ');
    if (!lead && !body.childNodes.length) {
      lead = line;
      continue;
    }
    const p = document.createElement('p');
    p.append(...inline(line));
    body.append(p);
  }
  return { lead, body };
}

/** **Bold** and [links](https://...); everything else is plain text */
function inline(text: string): Node[] {
  const out: Node[] = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
  let at = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m.index > at)
      out.push(document.createTextNode(text.slice(at, m.index)));
    if (m[1] !== undefined) {
      const b = document.createElement('strong');
      b.append(...inline(m[1]));
      out.push(b);
    } else {
      const a = document.createElement('a');
      a.href = m[3];
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = m[2];
      out.push(a);
    }
    at = re.lastIndex;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}
