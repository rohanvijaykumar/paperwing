/**
 * Driverless network scanners (escl.cjs, mdns.cjs) against the pretend eSCL
 * scanner in fake-escl.mjs: finding it, adding it by address, what it can
 * do, previews, flatbed and feeder scans, both sides, cancelling, and every
 * way a scan can go wrong. Multicast DNS is exercised over a loopback port
 * here; two optional runs use the real network:
 *
 *   ESCL_MULTICAST=1   the fake answers on the real multicast group
 *   ESCL_LIVE_NAME=X   finds and scans a scanner called X, announced by
 *                      something else (macOS CI registers the fake with
 *                      Bonjour's dns-sd)
 *
 *   node --test desktop/tests/escl.test.mjs
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startFakeEscl, drawPage, encodeJpeg, encodePng } from './fake-escl.mjs';

const require = createRequire(import.meta.url);
const escl = require('../escl.cjs');
const mdns = require('../mdns.cjs');
const { createEscl } = escl;

const FAST = {
  discoveryMs: 400,
  connectMs: 1000,
  requestMs: 3000,
  pageMs: 5000,
  probeMs: 2000,
  retryDelayMs: 5,
  maxRetryDelayMs: 20,
};
const workDir = mkdtempSync(join(tmpdir(), 'paperwing-escl-'));
let dirs = 0;
const outDir = () => join(workDir, `scan-${++dirs}`);

const fakes = [];
async function fake(options = {}) {
  const f = await startFakeEscl({ host: '127.0.0.1', mdns: { port: 0 }, ...options });
  fakes.push(f);
  return f;
}
after(() => Promise.all(fakes.map((f) => f.close())));

/** A client that finds `scanners` (over loopback multicast DNS) */
function client(scanners, config = {}) {
  return createEscl({
    mdnsTargets: scanners.map((s) => ({ address: '127.0.0.1', port: s.mdnsPort })),
    ...config,
    timeouts: { ...FAST, ...config.timeouts },
  });
}

/** Runs a scan (or preview) to the end; the events and the last one */
async function run(c, id, options = {}, { preview = false, onEvent } = {}) {
  const events = [];
  const handle = (preview ? c.preview : c.scan)(id, options, outDir(), (e) => {
    events.push(e);
    onEvent?.(e, handle);
  });
  const last = await handle.done;
  return { events, last, pages: events.filter((e) => e.type === 'page') };
}

const idOf = (f) => `escl:${f.uuid}`;
const posts = (f) => f.requests.filter((r) => r.method === 'POST');
const deletes = (f) => f.requests.filter((r) => r.method === 'DELETE');
const lastJob = (f) => [...f.jobs.values()].at(-1);

describe('multicast DNS packets', () => {
  test('a response survives encoding and decoding', () => {
    const buf = mdns.encodePacket({
      id: 7,
      response: true,
      questions: [{ name: '_uscan._tcp.local', type: mdns.TYPE.PTR }],
      answers: [{ name: '_uscan._tcp.local', type: mdns.TYPE.PTR, ttl: 10, data: 'Scanner é._uscan._tcp.local' }],
      additionals: [
        { name: 'Scanner é._uscan._tcp.local', type: mdns.TYPE.SRV, data: { port: 8080, target: 'host.local' } },
        { name: 'Scanner é._uscan._tcp.local', type: mdns.TYPE.TXT, data: { rs: 'eSCL', UUID: 'abc', flag: true } },
        { name: 'host.local', type: mdns.TYPE.A, data: '192.168.1.20' },
      ],
    });
    const p = mdns.decodePacket(buf);
    assert.equal(p.id, 7);
    assert.ok(p.response);
    assert.equal(p.questions[0].name, '_uscan._tcp.local');
    assert.equal(p.answers[0].data, 'Scanner é._uscan._tcp.local');
    assert.deepEqual(p.additionals[0].data, { priority: 0, weight: 0, port: 8080, target: 'host.local' });
    assert.deepEqual(p.additionals[1].data, { rs: 'eSCL', uuid: 'abc', flag: true });
    assert.equal(p.additionals[2].data, '192.168.1.20');
  });

  test('compressed names are followed', () => {
    // Header, question "a.local" (offset 12), answer named by a pointer to it
    const name = Buffer.from([1, 0x61, 5, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0]);
    const header = Buffer.from([0, 1, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
    const q = Buffer.concat([name, Buffer.from([0, 1, 0, 1])]);
    const answer = Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 120, 0, 4, 10, 0, 0, 5]);
    const p = mdns.decodePacket(Buffer.concat([header, q, answer]));
    assert.equal(p.answers[0].name, 'a.local');
    assert.equal(p.answers[0].data, '10.0.0.5');
  });

  test('broken packets throw instead of looping', () => {
    const header = Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    // A name pointing at itself
    assert.throws(() => mdns.decodePacket(Buffer.concat([header, Buffer.from([0xc0, 12, 0, 1, 0, 1])])));
    assert.throws(() => mdns.decodePacket(Buffer.concat([header, Buffer.from([5, 0x61])])));
    assert.throws(() => mdns.decodePacket(Buffer.from([1, 2, 3])));
  });
});

describe('finding scanners', () => {
  test('a scanner announced over multicast DNS appears as soon as it answers', async () => {
    const f = await fake({ name: 'Office Scanner', makeAndModel: 'Paperwing Test 3000' });
    const c = client([f], { timeouts: { discoveryMs: 1500 } });
    const started = Date.now();
    let seenAt = 0;
    const found = [];
    const result = await c.list({
      onDevice: (d) => {
        seenAt ||= Date.now() - started;
        found.push(d);
      },
    });
    assert.equal(result.type, 'scanners');
    assert.deepEqual(result.scanners, [
      {
        id: idOf(f),
        name: 'Office Scanner',
        driver: 'escl',
        deviceKey: f.uuid,
        make: 'Office',
        model: 'Scanner',
        connection: 'network',
      },
    ]);
    assert.deepEqual(found, result.scanners);
    // Streamed: long before the search ended
    assert.ok(seenAt < 1000, `found after ${seenAt} ms`);
  });

  test('several scanners, secure ones (_uscans) included', async () => {
    const a = await fake({ name: 'Canon Upstairs' });
    const b = await fake({ name: 'HP Downstairs', https: true });
    const c = client([a, b]);
    const { scanners } = await c.list();
    assert.deepEqual(
      scanners.map((s) => [s.name, s.make, s.model]).sort(),
      [
        ['Canon Upstairs', 'Canon', 'Upstairs'],
        ['HP Downstairs', 'HP', 'Downstairs'],
      ]
    );
    // The secure one works through its own self-signed certificate
    const caps = await c.caps(idOf(b));
    assert.equal(caps.type, 'caps');
  });

  test('scanners found before stay listed (cached) when they miss a search', async () => {
    const f = await fake();
    const targets = [{ address: '127.0.0.1', port: f.mdnsPort }];
    const c = createEscl({ mdnsTargets: targets, timeouts: FAST });
    assert.equal((await c.list()).scanners.length, 1);
    targets.length = 0; // it stops answering
    const again = [];
    const { scanners } = await c.list({ onDevice: (d) => again.push(d) });
    assert.deepEqual(scanners.map((s) => s.id), [idOf(f)]);
    assert.equal(again.length, 1);
    // ...but not forever
    const short = createEscl({ mdnsTargets: [{ address: '127.0.0.1', port: f.mdnsPort }], timeouts: { ...FAST, cacheMs: 0 } });
    await short.list();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await createEscl({ mdnsTargets: [], timeouts: FAST }).list()).scanners.length, 0);
  });

  test('no scanners: an empty list, not an error', async () => {
    const c = createEscl({ mdnsTargets: [], timeouts: FAST });
    assert.deepEqual(await c.list(), { type: 'scanners', scanners: [] });
  });

  test('an unknown scanner is reported as not found', async () => {
    const c = createEscl({ mdnsTargets: [], timeouts: FAST });
    const r = await c.caps('escl:not-a-scanner');
    assert.equal(r.type, 'error');
    assert.equal(r.code, 'no-scanner');
  });
});

describe('adding a scanner by address', () => {
  test('by IP address and port, then listed by every search', async () => {
    const f = await fake({ mdns: false });
    const c = createEscl({ mdnsTargets: [], timeouts: FAST });
    const added = await c.add(`127.0.0.1:${f.port}`);
    assert.equal(added.type, 'scanners');
    assert.equal(added.scanners[0].id, idOf(f));
    assert.equal(added.scanners[0].deviceKey, f.uuid);
    assert.equal(added.scanners[0].name, 'Paperwing Test Scanner 3000');
    const { scanners } = await c.list();
    assert.deepEqual(scanners.map((s) => s.id), [idOf(f)]);
    const caps = await c.caps(idOf(f));
    assert.equal(caps.type, 'caps');
  });

  test('as a URL, over HTTPS with a self-signed certificate', async () => {
    const f = await fake({ mdns: false, https: true });
    const c = createEscl({ mdnsTargets: [], timeouts: FAST });
    const added = await c.add(`https://127.0.0.1:${f.port}/eSCL`);
    assert.equal(added.type, 'scanners');
    const r = await run(c, idOf(f), { source: 'flatbed', dpi: 75 });
    assert.equal(r.last.type, 'done');
  });

  test('addresses given to the client at start are found again', async () => {
    const f = await fake({ mdns: false });
    const c = createEscl({ mdnsTargets: [], manualHosts: [`127.0.0.1:${f.port}`], timeouts: FAST });
    assert.equal((await c.caps(idOf(f))).type, 'caps');
    assert.ok(c.remove(`127.0.0.1:${f.port}`));
  });

  test('one entry when it is also announced', async () => {
    const f = await fake();
    const c = client([f]);
    await c.add(`127.0.0.1:${f.port}`);
    const { scanners } = await c.list();
    assert.equal(scanners.length, 1);
  });

  test('nothing there, or not an address', async () => {
    const c = createEscl({ mdnsTargets: [], timeouts: FAST });
    const nothing = await c.add('127.0.0.1:1');
    assert.equal(nothing.type, 'error');
    assert.equal(nothing.code, 'no-scanner');
    assert.match(nothing.message, /127\.0\.0\.1:1/);
    const bad = await c.add('not a host name');
    assert.equal(bad.code, 'no-scanner');
    const unknown = await c.add('no-such-scanner.invalid');
    assert.equal(unknown.code, 'no-scanner');
  });

  test('something that answers, but not as a scanner', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => res.end('<html>a router</html>'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const c = createEscl({ mdnsTargets: [], timeouts: FAST });
    const r = await c.add(`127.0.0.1:${server.address().port}`);
    server.close();
    assert.equal(r.code, 'no-scanner');
  });
});

describe('what a scanner can do', () => {
  test('a flatbed and a two-sided feeder', async () => {
    const f = await fake({ adf: { sheets: 2, duplex: true } });
    const caps = await client([f]).caps(idOf(f));
    assert.equal(caps.type, 'caps');
    assert.equal(caps.driver, 'escl');
    assert.equal(caps.nativeUi, false);
    const [flatbed, feeder] = caps.sources;
    assert.equal(flatbed.id, 'flatbed');
    assert.equal(feeder.id, 'feeder');
    assert.equal(flatbed.duplex, false);
    assert.equal(feeder.duplex, true);
    assert.deepEqual(flatbed.resolutions, [75, 150, 300, 600]);
    assert.deepEqual(flatbed.colors, ['color', 'gray', 'bw']);
    assert.equal(flatbed.maxWidth, 8.5);
    assert.equal(flatbed.maxHeight, 11.693);
    assert.equal(flatbed.minWidth, 0.053);
    assert.equal(flatbed.canPreview, true);
    assert.equal(feeder.canPreview, false);
    const sizes = flatbed.paperSizes.map((p) => p.name);
    assert.ok(sizes.includes('Letter') && sizes.includes('A4') && sizes.includes('A5'));
    assert.ok(!sizes.includes('Legal') && !sizes.includes('Tabloid') && !sizes.includes('A3'));
    assert.deepEqual(flatbed.brightness, { min: 0, max: 2000, step: 1, default: 1000 });
    assert.deepEqual(flatbed.contrast, { min: 0, max: 2000, step: 1, default: 1000 });
    assert.deepEqual(flatbed.threshold, { min: 0, max: 255, step: 1, default: 128 });
    assert.equal(flatbed.feederLoaded, null);
    assert.equal(feeder.feederLoaded, true);
    for (const key of ['autoDeskew', 'autoCrop', 'doubleFeed', 'invert', 'blankPageSkip'])
      assert.equal(feeder[key], false, key);
  });

  test('a range of resolutions, no brightness, no black and white', async () => {
    const f = await fake({
      resolutions: { min: 100, max: 1200, step: 50 },
      brightness: false,
      threshold: false,
      colorModes: ['RGB24', 'Grayscale8'],
      blankPage: true,
      sharpen: true,
      adf: { sheets: 0 },
    });
    const caps = await client([f]).caps(idOf(f));
    const [flatbed, feeder] = caps.sources;
    assert.deepEqual(flatbed.resolutions, { min: 100, max: 1200, step: 50 });
    assert.deepEqual(flatbed.colors, ['color', 'gray']);
    assert.equal(flatbed.brightness, null);
    assert.equal(flatbed.threshold, null);
    assert.deepEqual(flatbed.sharpen, { min: 0, max: 5, step: 1, default: 0 });
    assert.equal(feeder.duplex, false);
    assert.equal(feeder.blankPageSkip, true);
    assert.equal(flatbed.blankPageSkip, false);
    assert.equal(feeder.feederLoaded, false);
  });

  test('a feeder-only scanner', async () => {
    const f = await fake({ platen: false, adf: { sheets: 1 } });
    const c = client([f]);
    const caps = await c.caps(idOf(f));
    assert.deepEqual(caps.sources.map((s) => s.id), ['feeder']);
    const r = await run(c, idOf(f), {}, { preview: true });
    assert.equal(r.last.code, 'unsupported');
  });

  test('a scanner that only sends PDF files is not offered', async () => {
    const f = await fake({ formats: ['application/pdf'] });
    const caps = await client([f]).caps(idOf(f));
    assert.equal(caps.type, 'error');
    assert.equal(caps.code, 'unsupported');
  });

  test('ScannerCapabilities from other scanners: prefixes, entities, missing parts', () => {
    const xml = `<?xml version="1.0"?>
      <escl:ScannerCapabilities xmlns:escl="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:p="http://www.pwg.org/schemas/2010/12/sm">
        <p:Version>2.0</p:Version>
        <p:MakeAndModel>Brother MFC &amp; Co</p:MakeAndModel>
        <escl:UUID>urn:uuid:{ABCD-1234}</escl:UUID>
        <escl:Platen><escl:PlatenInputCaps>
          <escl:MaxWidth>2592</escl:MaxWidth><escl:MaxHeight>3600</escl:MaxHeight>
          <escl:SettingProfiles><escl:SettingProfile>
            <escl:ColorModes><escl:ColorMode>RGB24</escl:ColorMode><escl:ColorMode>BlackAndWhite1</escl:ColorMode></escl:ColorModes>
            <escl:DocumentFormats><p:DocumentFormat>image/jpeg</p:DocumentFormat></escl:DocumentFormats>
            <escl:SupportedResolutions><escl:DiscreteResolutions>
              <escl:DiscreteResolution><escl:XResolution>300</escl:XResolution><escl:YResolution>300</escl:YResolution></escl:DiscreteResolution>
              <escl:DiscreteResolution><escl:XResolution>100</escl:XResolution><escl:YResolution>100</escl:YResolution></escl:DiscreteResolution>
            </escl:DiscreteResolutions></escl:SupportedResolutions>
          </escl:SettingProfile></escl:SettingProfiles>
        </escl:PlatenInputCaps></escl:Platen>
        <![CDATA[ ignored ]]>
      </escl:ScannerCapabilities>`;
    const model = escl.parseCapabilities(xml);
    assert.equal(model.makeAndModel, 'Brother MFC & Co');
    assert.equal(model.uuid, 'abcd-1234');
    assert.equal(model.adfSimplex, null);
    const ev = escl.capsEvent(model, null);
    assert.deepEqual(ev.sources[0].resolutions, [100, 300]);
    assert.deepEqual(ev.sources[0].colors, ['color', 'bw']);
    assert.equal(ev.sources[0].maxWidth, 8.64);
    assert.equal(ev.sources[0].minWidth, 0);
    // No threshold support: none offered, even with black and white
    assert.equal(ev.sources[0].threshold, null);
    assert.throws(() => escl.parseCapabilities('<html>not a scanner</html>'));
    // Broken XML gives what could be read, without hanging
    assert.equal(escl.parseXml('<a><b>1</b><c').children[0].name, 'a');
  });

  test('the settings sent: area, units, format and only what is supported', () => {
    const model = escl.parseCapabilities(sampleCaps());
    const s = escl.buildScanSettings(model, {
      source: 'feeder',
      duplex: true,
      color: 'bw',
      dpi: 200,
      paper: { width: 5.83, height: 8.27 },
      brightness: 5000,
      threshold: 100,
      blankPageSkip: true,
    });
    assert.equal(s.dpi, 150);
    assert.equal(s.duplex, true);
    assert.equal(s.format, 'image/png');
    assert.match(s.xml, /<pwg:InputSource>Feeder<\/pwg:InputSource>/);
    assert.match(s.xml, /<scan:Duplex>true<\/scan:Duplex>/);
    assert.match(s.xml, /<scan:ColorMode>BlackAndWhite1<\/scan:ColorMode>/);
    assert.match(s.xml, /escl:ThreeHundredthsOfInches/);
    // Centred in the feeder: (2550 - 1749) / 2
    assert.match(s.xml, /<pwg:XOffset>401<\/pwg:XOffset>/);
    assert.match(s.xml, /<pwg:Width>1749<\/pwg:Width>/);
    assert.match(s.xml, /<scan:Brightness>2000<\/scan:Brightness>/); // clamped
    assert.match(s.xml, /<scan:Threshold>100<\/scan:Threshold>/);
    assert.match(s.xml, /<scan:DocumentFormatExt>image\/png<\/scan:DocumentFormatExt>/);
    assert.match(s.xml, /<scan:Intent>Document<\/scan:Intent>/);
    assert.doesNotMatch(s.xml, /BlankPage/); // not supported by this one

    const auto = escl.buildScanSettings(model, { source: 'flatbed', paper: 'auto', color: 'gray' });
    assert.doesNotMatch(auto.xml, /ScanRegion/);
    assert.doesNotMatch(auto.xml, /Duplex|Threshold|Brightness/);
    assert.equal(auto.format, 'image/jpeg');
    const preview = escl.buildScanSettings(model, { dpi: 600 }, { preview: true });
    assert.equal(preview.dpi, 75);
    assert.match(preview.xml, /<scan:Intent>Preview<\/scan:Intent>/);
    assert.match(preview.xml, /<pwg:Width>2550<\/pwg:Width>/);
  });
});

/** ScannerCapabilities as the fake sends it (feeder with duplex) */
function sampleCaps() {
  return `<?xml version="1.0"?><scan:ScannerCapabilities xmlns:scan="s" xmlns:pwg="p">
  <pwg:Version>2.63</pwg:Version>
  ${['Platen><scan:PlatenInputCaps', 'Adf><scan:AdfSimplexInputCaps']
    .map((open, i) => {
      const [outer, inner] = open.split('><scan:');
      const extra = i ? '<scan:AdfDuplexInputCaps>' + profile() + '</scan:AdfDuplexInputCaps><scan:Justification><pwg:XImagePosition>Center</pwg:XImagePosition></scan:Justification>' : '';
      return `<scan:${outer}><scan:${inner}>${profile()}</scan:${inner}>${extra}</scan:${outer}>`;
    })
    .join('')}
  <scan:BrightnessSupport><scan:Min>0</scan:Min><scan:Max>2000</scan:Max><scan:Normal>1000</scan:Normal></scan:BrightnessSupport>
  <scan:ThresholdSupport><scan:Min>0</scan:Min><scan:Max>255</scan:Max><scan:Normal>128</scan:Normal></scan:ThresholdSupport>
  </scan:ScannerCapabilities>`;
  function profile() {
    return `<scan:MinWidth>16</scan:MinWidth><scan:MaxWidth>2550</scan:MaxWidth><scan:MinHeight>16</scan:MinHeight><scan:MaxHeight>3508</scan:MaxHeight>
      <scan:SettingProfiles><scan:SettingProfile>
      <scan:ColorModes><scan:ColorMode>RGB24</scan:ColorMode><scan:ColorMode>Grayscale8</scan:ColorMode><scan:ColorMode>BlackAndWhite1</scan:ColorMode></scan:ColorModes>
      <scan:DocumentFormats><pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat><pwg:DocumentFormat>image/png</pwg:DocumentFormat><scan:DocumentFormatExt>image/png</scan:DocumentFormatExt></scan:DocumentFormats>
      <scan:SupportedResolutions><scan:DiscreteResolutions>${[75, 150, 300]
        .map((d) => `<scan:DiscreteResolution><scan:XResolution>${d}</scan:XResolution><scan:YResolution>${d}</scan:YResolution></scan:DiscreteResolution>`)
        .join('')}</scan:DiscreteResolutions></scan:SupportedResolutions>
      </scan:SettingProfile></scan:SettingProfiles>
      <scan:SupportedIntents><scan:Intent>Document</scan:Intent><scan:Intent>Preview</scan:Intent></scan:SupportedIntents>`;
  }
}

describe('preview and flatbed scans', () => {
  test('a preview: the whole glass, quickly, as one page', async () => {
    const f = await fake();
    const r = await run(client([f]), idOf(f), {}, { preview: true });
    assert.deepEqual(r.last, { type: 'done', pages: 1 });
    assert.equal(r.pages.length, 1);
    const page = r.pages[0];
    assert.equal(page.dpi, 75);
    assert.equal(page.side, 'front');
    assert.equal(page.width, 638); // 8.5 in at 75 dpi
    assert.equal(page.height, 877);
    assert.ok(existsSync(page.file));
    const job = lastJob(f);
    assert.equal(job.settings.intent, 'Preview');
    assert.ok(job.deleted, 'the job is deleted afterwards');
  });

  test('a page: settings honoured, the job deleted, a stray job address handled', async () => {
    const f = await fake();
    const r = await run(client([f]), idOf(f), {
      source: 'flatbed',
      color: 'gray',
      dpi: 150,
      paper: { width: 8.5, height: 11 },
      brightness: 1200,
      contrast: 900,
    });
    assert.deepEqual(r.last, { type: 'done', pages: 1 });
    const [page] = r.pages;
    assert.deepEqual([page.width, page.height, page.dpi], [1275, 1650, 150]);
    assert.match(page.file, /page-1\.jpg$/);
    const data = readFileSync(page.file);
    assert.deepEqual([...data.subarray(0, 2)], [0xff, 0xd8]);
    const job = lastJob(f);
    assert.equal(job.settings.mode, 'Grayscale8');
    assert.match(job.xml, /<scan:Brightness>1200<\/scan:Brightness>/);
    assert.match(job.xml, /<scan:Contrast>900<\/scan:Contrast>/);
    // The fake says the job is at localhost:1; only its path was used
    assert.ok(f.requests.some((q) => q.path.endsWith('/NextDocument')));
    assert.ok(job.deleted);
    // Status messages as it goes
    assert.ok(r.events.some((e) => e.type === 'status' && /Scanning page 1/.test(e.message)));
  });

  test('a scan area, the nearest resolution, black and white as 1-bit PNG', async () => {
    const f = await fake();
    const r = await run(client([f]), idOf(f), {
      source: 'flatbed',
      color: 'bw',
      dpi: 200,
      threshold: 90,
      area: { x: 1, y: 1.5, width: 2, height: 3 },
    });
    assert.equal(r.last.type, 'done');
    const job = lastJob(f);
    assert.equal(job.settings.dpi, 150);
    assert.equal(job.settings.format, 'image/png');
    assert.match(job.xml, /<pwg:XOffset>300<\/pwg:XOffset>/);
    assert.match(job.xml, /<pwg:YOffset>450<\/pwg:YOffset>/);
    assert.match(job.xml, /<scan:Threshold>90<\/scan:Threshold>/);
    assert.deepEqual([r.pages[0].width, r.pages[0].height], [300, 450]);
    assert.match(r.pages[0].file, /\.png$/);
  });

  test('a range of resolutions: snapped to its steps', async () => {
    const f = await fake({ resolutions: { min: 75, max: 1200, step: 25 } });
    const r = await run(client([f]), idOf(f), { dpi: 310, paper: { width: 2, height: 2 } });
    assert.equal(r.last.type, 'done');
    assert.equal(lastJob(f).settings.dpi, 300);
  });

  test("settings a scanner doesn't have aren't sent", async () => {
    const f = await fake({ brightness: false, threshold: false });
    const r = await run(client([f]), idOf(f), { dpi: 75, brightness: 10, contrast: 10, threshold: 10, color: 'bw' });
    assert.equal(r.last.type, 'done');
    assert.doesNotMatch(lastJob(f).xml, /Brightness|Contrast|Threshold/);
  });

  test("HP's server: a new job with Host: localhost", async () => {
    const f = await fake({ serverHeader: 'HP HTTP Server; HP_Compact_Server', quirks: { hpCompact: true } });
    const r = await run(client([f]), idOf(f), { dpi: 75 });
    assert.equal(r.last.type, 'done');
    assert.match(posts(f)[0].host, /^localhost:\d+$/);
    // Other requests keep the scanner's address
    assert.match(f.requests.find((q) => q.method === 'GET').host, /^127\.0\.0\.1:\d+$/);
  });
});

describe('the document feeder', () => {
  test('one side: a page per sheet until the feeder is empty', async () => {
    const f = await fake({ adf: { sheets: 3 } });
    const r = await run(client([f]), idOf(f), { source: 'feeder', dpi: 75, paper: { width: 8.5, height: 11 } });
    assert.deepEqual(r.last, { type: 'done', pages: 3 });
    assert.deepEqual(r.pages.map((p) => p.side), ['front', 'front', 'front']);
    assert.deepEqual(r.pages.map((p) => p.file.match(/page-(\d)/)[1]), ['1', '2', '3']);
    assert.equal(f.sheets, 0);
    assert.ok(lastJob(f).deleted);
  });

  test('both sides: front and back of each sheet, in order', async () => {
    const f = await fake({ adf: { sheets: 2, duplex: true } });
    const r = await run(client([f]), idOf(f), { source: 'feeder', duplex: true, dpi: 75 });
    assert.deepEqual(r.last, { type: 'done', pages: 4 });
    assert.deepEqual(r.pages.map((p) => p.side), ['front', 'back', 'front', 'back']);
    assert.equal(lastJob(f).settings.duplex, true);
  });

  test('both sides asked of a one-sided feeder: one side', async () => {
    const f = await fake({ adf: { sheets: 2 } });
    const r = await run(client([f]), idOf(f), { source: 'feeder', duplex: true, dpi: 75 });
    assert.deepEqual(r.last, { type: 'done', pages: 2 });
    assert.doesNotMatch(lastJob(f).xml, /Duplex/);
  });
});

describe('when things go wrong', () => {
  const fails = async (options, scan, code) => {
    const f = await fake(options);
    const r = await run(client([f]), idOf(f), scan);
    assert.equal(r.last.type, 'error', JSON.stringify(r.last));
    assert.equal(r.last.code, code);
    assert.ok(r.last.message.length > 10);
    return { f, r };
  };

  test('the feeder is empty', async () => {
    await fails({ adf: { sheets: 0 } }, { source: 'feeder', dpi: 75 }, 'feeder-empty');
  });

  test('paper jams after the first sheet: that page arrives, then the jam', async () => {
    const { f, r } = await fails({ adf: { sheets: 3 }, errors: { jamAfter: 1 } }, { source: 'feeder', dpi: 75 }, 'paper-jam');
    assert.equal(r.pages.length, 1);
    assert.ok(lastJob(f).deleted);
  });

  test('two sheets pulled together', async () => {
    await fails({ adf: { sheets: 3 }, errors: { multipickAfter: 1 } }, { source: 'feeder', dpi: 75 }, 'double-feed');
  });

  test("the feeder's cover is open", async () => {
    await fails({ adf: { sheets: 3 }, errors: { coverOpen: true } }, { source: 'feeder', dpi: 75 }, 'cover-open');
  });

  test("a feeder the scanner doesn't have", async () => {
    const f = await fake();
    const c = client([f]);
    await c.caps(idOf(f));
    const r = await run(c, idOf(f), { source: 'feeder' });
    assert.equal(r.last.code, 'unsupported');
    assert.equal(posts(f).length, 0, 'not even sent');
  });

  test('busy just after another scan: it waits, then scans', async () => {
    const f = await fake({ errors: { busy: 3 } });
    const r = await run(client([f]), idOf(f), { dpi: 75 });
    assert.equal(r.last.type, 'done');
    assert.ok(r.events.some((e) => e.type === 'status' && /Waiting/.test(e.message)));
  });

  test('busy for good: reported as busy', async () => {
    await fails({ errors: { busy: 100 } }, { dpi: 75 }, 'busy');
  });

  test('503s everywhere at first: asked again each time', async () => {
    const f = await fake({ adf: { sheets: 2 }, errors: { flaky: 3 } });
    const c = client([f]);
    assert.equal((await c.caps(idOf(f))).type, 'caps');
    const r = await run(c, idOf(f), { source: 'feeder', dpi: 75 });
    assert.deepEqual(r.last, { type: 'done', pages: 2 });
  });

  test('"no page" before the first one is ready (Xerox): asked again', async () => {
    const f = await fake({ errors: { lateFirstPage: 3 } });
    const r = await run(client([f]), idOf(f), { dpi: 75 });
    assert.deepEqual(r.last, { type: 'done', pages: 1 });
  });

  test("a scanner that stops answering mid-scan doesn't hang", async () => {
    const f = await fake({ errors: { hang: 'page' } });
    const started = Date.now();
    const r = await run(client([f], { timeouts: { pageMs: 600 } }), idOf(f), { dpi: 75 });
    assert.equal(r.last.code, 'failed');
    assert.match(r.last.message, /stopped responding/);
    assert.ok(Date.now() - started < 3000);
    assert.ok(lastJob(f).deleted, 'the job is deleted');
  });

  test("a scanner that doesn't answer when asked what it can do", async () => {
    const f = await fake({ errors: { hang: 'caps' } });
    const started = Date.now();
    const caps = await client([f], { timeouts: { requestMs: 500 } }).caps(idOf(f));
    assert.equal(caps.type, 'error');
    assert.ok(Date.now() - started < 3000);
  });

  test("a status that never comes doesn't stop the scan", async () => {
    const f = await fake({ errors: { hang: 'status' } });
    const r = await run(client([f], { timeouts: { requestMs: 400 } }), idOf(f), { dpi: 75 });
    assert.equal(r.last.type, 'done');
  });

  test('switched off since it was found: offline', async () => {
    const f = await fake();
    const c = client([f]);
    await c.list();
    await f.close();
    const r = await run(c, idOf(f), { dpi: 75 });
    assert.equal(r.last.code, 'offline');
  });

  test('an address that never answers: offline, after the connection time limit', async () => {
    // Announced at an address nothing answers on (TEST-NET-1, RFC 5737)
    const f = await fake({ mdns: { port: 0, address: '192.0.2.1' } });
    const started = Date.now();
    const caps = await client([f], { timeouts: { connectMs: 500 } }).caps(idOf(f));
    assert.equal(caps.code, 'offline');
    assert.ok(Date.now() - started < 4000);
  });
});

describe('cancelling', () => {
  test('mid-job: stops at once, deletes the job, keeps the pages so far', async () => {
    const f = await fake({ adf: { sheets: 5 }, errors: { slowPageMs: 400 } });
    let cancelledAt = 0;
    const r = await run(client([f]), idOf(f), { source: 'feeder', dpi: 75 }, {
      onEvent: (e, handle) => {
        if (e.type === 'page' && !cancelledAt) {
          cancelledAt = Date.now();
          handle.cancel();
        }
      },
    });
    assert.deepEqual(r.last, { type: 'done', pages: 1, cancelled: true });
    assert.ok(Date.now() - cancelledAt < 1000, 'promptly');
    const job = lastJob(f);
    assert.ok(job.deleted);
    assert.equal(deletes(f).length, 1);
    assert.equal(job.state, 'Canceled');
  });

  test('before the job starts: nothing left behind on the scanner', async () => {
    const f = await fake({ errors: { busy: 2 } });
    const c = client([f]);
    await c.caps(idOf(f));
    const handle = c.scan(idOf(f), { dpi: 75 }, outDir(), () => {});
    handle.cancel();
    handle.cancel(); // twice is fine
    const last = await handle.done;
    assert.deepEqual(last, { type: 'done', pages: 0, cancelled: true });
    for (const job of f.jobs.values()) assert.ok(job.deleted);
  });

  test('while the scanner is busy: no waiting it out', async () => {
    const f = await fake({ errors: { busy: 100 } });
    const c = client([f], { timeouts: { retryDelayMs: 200, maxRetryDelayMs: 200 } });
    await c.caps(idOf(f));
    const started = Date.now();
    const handle = c.scan(idOf(f), { dpi: 75 }, outDir(), () => {});
    setTimeout(() => handle.cancel(), 300);
    const last = await handle.done;
    assert.equal(last.cancelled, true);
    assert.ok(Date.now() - started < 1500);
  });
});

describe('helpers', () => {
  test('image kinds and sizes', () => {
    const page = drawPage(40, 30, { n: 2 });
    assert.deepEqual(escl.imageInfo(encodePng(page)), { ext: 'png', width: 40, height: 30 });
    assert.deepEqual(escl.imageInfo(encodeJpeg(page)), { ext: 'jpg', width: 40, height: 30 });
    assert.equal(escl.imageInfo(Buffer.from('%PDF-1.7')), null);
  });

  test('self-signed certificates are accepted only on the local network', () => {
    for (const ip of ['192.168.1.2', '10.0.0.1', '172.16.5.4', '169.254.1.1', '127.0.0.1', '::1', 'fe80::1%en0', 'fd00::5', '::ffff:192.168.0.9'])
      assert.ok(escl.isLocalAddress(ip), ip);
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1', 'scanner.example.com'])
      assert.ok(!escl.isLocalAddress(ip), ip);
  });

  test('make and model from a name', () => {
    assert.deepEqual(escl.splitMakeModel('Hewlett-Packard LaserJet M28w'), { make: 'HP', model: 'LaserJet M28w' });
    assert.deepEqual(escl.splitMakeModel('Konica Minolta bizhub C258'), { make: 'Konica Minolta', model: 'bizhub C258' });
    assert.deepEqual(escl.splitMakeModel('Scanner'), { make: '', model: 'Scanner' });
  });
});

// --- On the real network (optional) ----------------------------------------

test('real multicast: the fake answers on the multicast group', { skip: !process.env.ESCL_MULTICAST }, async () => {
  const f = await startFakeEscl({ mdns: { port: 5353 }, adf: { sheets: 1 } });
  fakes.push(f);
  const c = createEscl({ timeouts: { ...FAST, discoveryMs: 4000 } });
  const result = await c.list();
  assert.ok(result.scanners?.some((s) => s.id === idOf(f)), JSON.stringify(result));
  const r = await run(c, idOf(f), { source: 'feeder', dpi: 75 });
  assert.deepEqual(r.last, { type: 'done', pages: 1 });
});

test('live: finds and scans a scanner announced by the system', { skip: !process.env.ESCL_LIVE_NAME }, async () => {
  const c = createEscl({ timeouts: { discoveryMs: 6000 } });
  const result = await c.list();
  console.log('found', JSON.stringify(result));
  // What the network looked like, if nothing was found
  if (!result.scanners?.length) {
    console.log('adapters', JSON.stringify(mdns.localInterfaces()));
    await mdns.browse({ types: ['_uscan._tcp.local'], timeoutMs: 2000 }).then(
      (r) => console.log('browse', JSON.stringify(r)),
      (e) => console.log('browse failed', e.code, e.message)
    );
  }
  let s = result.scanners?.find((x) => x.name === process.env.ESCL_LIVE_NAME);
  // Where this process may not use multicast (macOS Local Network privacy
  // on CI), the address the system's Bonjour resolved it to
  if (!s && result.code === 'blocked' && process.env.ESCL_LIVE_ADDRESS) {
    console.log('multicast blocked here; adding', process.env.ESCL_LIVE_ADDRESS);
    const added = await c.add(process.env.ESCL_LIVE_ADDRESS);
    console.log('added', JSON.stringify(added));
    s = added.scanners?.[0];
  }
  assert.ok(s, `no scanner called ${process.env.ESCL_LIVE_NAME}`);
  const caps = await c.caps(s.id);
  assert.equal(caps.type, 'caps', JSON.stringify(caps));
  const r = await run(c, s.id, { source: caps.sources[0].id, dpi: 75 });
  assert.equal(r.last.type, 'done', JSON.stringify(r.last));
  assert.ok(r.pages.length >= 1);
});
