// Which page of the viewer is which (form-layer.ts findPages), used by the
// form fields and by Digitally sign's box: pages of different widths
// (mixed rotations) are centred, away from their layout slot's corner.
import { describe, expect, it } from 'vitest';
import { findPages } from '../acro/form-layer';

function viewer(pages: { x: number; y: number; w: number; h: number }[]) {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const content = document.createElement('div');
  content.style.margin = '0px auto';
  content.style.position = 'relative';
  root.append(content);
  const rect = (x: number, y: number, w: number, h: number) =>
    ({
      left: x,
      top: y,
      width: w,
      height: h,
      right: x + w,
      bottom: y + h,
      x,
      y,
    }) as DOMRect;
  content.getBoundingClientRect = () => rect(0, 0, 1200, 5000);
  const boxes = pages.map((p) => {
    const outer = document.createElement('div');
    const turn = document.createElement('div');
    const box = document.createElement('div');
    box.style.position = 'relative';
    box.style.width = `${p.w}px`;
    box.append(document.createElement('img'));
    turn.append(box);
    outer.append(turn);
    content.append(outer);
    outer.getBoundingClientRect = () => rect(p.x, p.y, p.w, p.h);
    return box;
  });
  return { root, boxes };
}

describe('finding the viewer’s pages', () => {
  it('portrait pages centred among landscape ones (mixed rotations)', () => {
    // Pages 1 and 3 portrait (612 wide), 2 and 4 turned (792 wide)
    const { root, boxes } = viewer([
      { x: 90, y: 0, w: 612, h: 792 },
      { x: 0, y: 802, w: 792, h: 612 },
      { x: 90, y: 1424, w: 612, h: 792 },
      { x: 0, y: 2226, w: 792, h: 612 },
    ]);
    const layout = {
      scale: 1,
      pages: new Map([
        [0, { x: 0, y: 0 }],
        [1, { x: 0, y: 802 }],
        [2, { x: 0, y: 1424 }],
        [3, { x: 0, y: 2226 }],
      ]),
    };
    const found = findPages(root, layout);
    expect(found.map((f) => f.index)).toEqual([0, 1, 2, 3]);
    expect(found.map((f) => f.page)).toEqual(boxes);
  });

  it('pages side by side (a spread) keep their order', () => {
    const { root } = viewer([
      { x: 0, y: 0, w: 612, h: 792 },
      { x: 622, y: 0, w: 612, h: 792 },
    ]);
    const layout = {
      scale: 1,
      pages: new Map([
        [0, { x: 0, y: 0 }],
        [1, { x: 622, y: 0 }],
      ]),
    };
    expect(findPages(root, layout).map((f) => f.index)).toEqual([0, 1]);
  });

  it('a page nowhere near the layout (still moving) isn’t matched', () => {
    const { root } = viewer([{ x: 300, y: 300, w: 612, h: 792 }]);
    const layout = { scale: 1, pages: new Map([[0, { x: 0, y: 0 }]]) };
    expect(findPages(root, layout)).toEqual([]);
  });
});
