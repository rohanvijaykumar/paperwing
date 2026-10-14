// Throwaway: inspect the viewer's DOM after opening a PDF
import { readFileSync } from 'node:fs';
import { launch, sleep } from './harness.mjs';

const file = process.argv[2];
const app = await launch();
const b64 = readFileSync(file).toString('base64');
await app.page.evaluate(
  async ({ b64, name }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
    window.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      })
    );
  },
  { b64, name: 'x.pdf' }
);
await sleep(4000);
const info = await app.page.evaluate(() => {
  const root = document.querySelector(
    '#viewer-host embedpdf-container'
  ).shadowRoot;
  const base = [...root.querySelectorAll('img')].find(
    (i) => i.style.width === '100%'
  );
  const chain = [];
  let el = base;
  for (let i = 0; i < 6 && el; i++) {
    chain.push({
      tag: el.tagName,
      attrs: [...el.attributes].map((a) => `${a.name}=${a.value.slice(0, 90)}`),
    });
    el = el.parentElement;
  }
  const scroller = root.querySelector('div.bg-bg-app');
  const kids = scroller.firstElementChild;
  return JSON.stringify(
    {
      chain,
      scrollerChild: [...kids.attributes].map(
        (a) => `${a.name}=${a.value.slice(0, 120)}`
      ),
      grand: [...kids.children]
        .slice(0, 3)
        .map((c) =>
          [...c.attributes].map((a) => `${a.name}=${a.value.slice(0, 140)}`)
        ),
      nGrand: kids.children.length,
      sh: scroller.scrollHeight,
    },
    null,
    1
  );
});
console.log(info);
await app.close();
