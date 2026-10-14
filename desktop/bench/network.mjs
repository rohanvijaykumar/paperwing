import { launch, sleep } from './harness.mjs';
const app = await launch();
const lines = [];
app.child.stdout.on('data', (b) =>
  String(b)
    .split(/\r?\n/)
    .filter((l) => l.includes('network'))
    .forEach((l) => lines.push(l))
);
await sleep(2500);
lines.push('--- opening files');
for (const f of process.argv.slice(2)) {
  await app.openFile(f);
  await sleep(3000);
}
console.log(lines.join('\n') || 'no network requests');
await app.close();
