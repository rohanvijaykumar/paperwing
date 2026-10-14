// CPU profile of the workspace page while a file opens: top functions by self time
import { launch, sleep } from './harness.mjs';
const app = await launch();
await sleep(2500);
const cdp = await app.page.createCDPSession();
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await app.openFile(process.argv[2]);
await sleep(Number(process.argv[3] || 1500));
const { profile } = await cdp.send('Profiler.stop');
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas;
profile.samples.forEach((id, i) => {
  const n = byId.get(id);
  const f = n.callFrame;
  const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}:${f.columnNumber}`;
  self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
});
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
for (const [k, ms] of top) console.log(ms.toFixed(1).padStart(8), 'ms ', k);
await app.close();
