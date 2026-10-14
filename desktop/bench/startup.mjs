/**
 * Startup benchmark: how long until something, and then the app, is on screen.
 *   node bench/startup.mjs [runs]
 */
import { launch, sleep, stats } from './harness.mjs';

const runs = Number(process.argv[2] || 5);
const rows = [];
for (let i = 0; i < runs; i++) {
  const app = await launch();
  // Renderer-side timings for the workspace page
  const nav = await app.page.evaluate(() => {
    const paint = Object.fromEntries(
      performance.getEntriesByType('paint').map((p) => [p.name, p.startTime])
    );
    const n = performance.getEntriesByType('navigation')[0];
    return {
      fcp: paint['first-contentful-paint'] ?? null,
      domContentLoaded: n?.domContentLoadedEventEnd ?? null,
    };
  });
  rows.push({ ...app.marks, ...nav });
  if (process.env.BENCH_VERBOSE)
    console.log(`  run ${i + 1}:`, JSON.stringify(rows.at(-1)));
  await sleep(300);
  await app.close();
  await sleep(500);
}

const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
console.log(
  `startup over ${runs} runs (ms; main-process marks are since process start)`
);
for (const k of keys) {
  const vals = rows.map((r) => r[k]).filter((x) => typeof x === 'number');
  if (vals.length)
    console.log(`  ${k.padEnd(24)} ${JSON.stringify(stats(vals))}`);
}
