// CPU profile while scrolling an open document
import { readFileSync } from 'node:fs';
import { launch, sleep } from './harness.mjs';
const src = readFileSync(new URL('./interact.mjs', import.meta.url), 'utf8');
const helpers = src.slice(
  src.indexOf('const PAGE_HELPERS = ') + 'const PAGE_HELPERS = '.length,
  src.indexOf('\nconst results')
);
const app = await launch();
await app.page.evaluate(`(${helpers.trim().replace(/;$/, '')})()`);
await sleep(2000);
const shown = app.page.evaluate(() => window.__bench.firstPage(60000));
await app.openFile(process.argv[2]);
await shown;
await sleep(1000);
const cdp = await app.page.createCDPSession();
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
const r = await app.page.evaluate(() => window.__bench.scroll(Number(3000), 5));
const { profile } = await cdp.send('Profiler.stop');
console.log('scroll', JSON.stringify(r));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
profile.samples.forEach((id, i) => {
  const f = byId.get(id).callFrame;
  const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}:${f.columnNumber}`;
  self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0) / 1000);
});
for (const [k, ms] of [...self.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 14))
  console.log(ms.toFixed(1).padStart(8), 'ms ', k);
await app.close();
