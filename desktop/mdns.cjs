/**
 * Finding network services on the local network with multicast DNS
 * (DNS-SD, RFC 6762/6763), for driverless scanners (escl.cjs).
 *
 * Queries go out from an ordinary, randomly numbered UDP port ("legacy
 * unicast", RFC 6762 section 6.7), and responders must answer straight back
 * to it. That way Paperwing never binds port 5353, which is owned by the
 * system's own responder (Bonjour, Windows' DNS client, Avahi), and on
 * Windows the reply arrives through the firewall's built-in allowance for
 * answers to multicast queries, so there's no "allow Paperwing on networks"
 * prompt. A responder that ignores the rule and only multicasts its answer
 * isn't seen; those scanners can still be added by IP address.
 *
 * The packet code is shared with the pretend scanner in tests/fake-escl.mjs.
 */
const dgram = require('node:dgram');
const os = require('node:os');

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 };
/** Class IN, with the top bit: "unicast response wanted" in a question,
 *  "flush the cache" in an answer */
const IN = 1;
const TOP_BIT = 0x8000;

// --- Packets ---------------------------------------------------------------

function encodeName(name) {
  const parts = [];
  for (const label of String(name).replace(/\.$/, '').split('.')) {
    if (!label) continue;
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > 63) throw new RangeError('DNS label too long');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function encodeTxt(txt) {
  const entries = Array.isArray(txt)
    ? txt
    : Object.entries(txt ?? {}).map(([k, v]) => (v === true ? k : `${k}=${v}`));
  const parts = entries.map((e) => {
    const b = Buffer.from(String(e), 'utf8').subarray(0, 255);
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  // An empty TXT record still holds one empty string (RFC 6763 section 6.1)
  return parts.length ? Buffer.concat(parts) : Buffer.from([0]);
}

function encodeRecordData(type, data) {
  switch (type) {
    case TYPE.A:
      return Buffer.from(String(data).split('.').map(Number));
    case TYPE.PTR:
      return encodeName(data);
    case TYPE.TXT:
      return encodeTxt(data);
    case TYPE.SRV: {
      const head = Buffer.alloc(6);
      head.writeUInt16BE(data.priority ?? 0, 0);
      head.writeUInt16BE(data.weight ?? 0, 2);
      head.writeUInt16BE(data.port, 4);
      return Buffer.concat([head, encodeName(data.target)]);
    }
    default:
      return Buffer.from(data ?? []);
  }
}

/**
 * A packet: { id, response, questions: [{ name, type, unicast }],
 * answers / additionals: [{ name, type, ttl, data, flush }] }.
 * Names aren't compressed (allowed, and keeps this short).
 */
function encodePacket({
  id = 0,
  response = false,
  questions = [],
  answers = [],
  additionals = [],
}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(response ? 0x8400 : 0, 2); // QR + authoritative
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(additionals.length, 10);
  const parts = [header];
  for (const q of questions) {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE(IN | (q.unicast ? TOP_BIT : 0), 2);
    parts.push(encodeName(q.name), tail);
  }
  for (const r of [...answers, ...additionals]) {
    const data = encodeRecordData(r.type, r.data);
    const tail = Buffer.alloc(10);
    tail.writeUInt16BE(r.type, 0);
    tail.writeUInt16BE(IN | (r.flush ? TOP_BIT : 0), 2);
    tail.writeUInt32BE(r.ttl ?? 120, 4);
    tail.writeUInt16BE(data.length, 8);
    parts.push(encodeName(r.name), tail, data);
  }
  return Buffer.concat(parts);
}

/** A name at `offset`, following compression pointers: [name, next offset] */
function decodeName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = -1;
  // Each pointer must go backwards, so a malicious packet can't loop
  let limit = offset;
  for (let guard = 0; guard < 128; guard++) {
    if (pos >= buf.length) throw new RangeError('Truncated DNS name');
    const len = buf[pos];
    if (len === 0) {
      if (next < 0) next = pos + 1;
      return [labels.join('.'), next];
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new RangeError('Truncated DNS name');
      const target = ((len & 0x3f) << 8) | buf[pos + 1];
      if (next < 0) next = pos + 2;
      if (target >= limit) throw new RangeError('Bad DNS name pointer');
      limit = target;
      pos = target;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new RangeError('Bad DNS label');
    if (pos + 1 + len > buf.length) throw new RangeError('Truncated DNS name');
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  throw new RangeError('DNS name too long');
}

/** TXT strings as { key (lowercase): value }; a bare key is true */
function decodeTxt(buf) {
  const txt = {};
  let pos = 0;
  while (pos < buf.length) {
    const len = buf[pos];
    const entry = buf.toString('utf8', pos + 1, pos + 1 + len);
    pos += 1 + len;
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const key = (eq < 0 ? entry : entry.slice(0, eq)).toLowerCase();
    // The first occurrence of a key wins (RFC 6763 section 6.4)
    if (key && !(key in txt)) txt[key] = eq < 0 ? true : entry.slice(eq + 1);
  }
  return txt;
}

function decodeRecord(buf, offset) {
  const [name, pos] = decodeName(buf, offset);
  if (pos + 10 > buf.length) throw new RangeError('Truncated DNS record');
  const type = buf.readUInt16BE(pos);
  const cls = buf.readUInt16BE(pos + 2);
  const ttl = buf.readUInt32BE(pos + 4);
  const len = buf.readUInt16BE(pos + 8);
  const start = pos + 10;
  const end = start + len;
  if (end > buf.length) throw new RangeError('Truncated DNS record');
  let data = buf.subarray(start, end);
  if (type === TYPE.A && len === 4) data = [...data].join('.');
  else if (type === TYPE.AAAA && len === 16)
    data = [0, 2, 4, 6, 8, 10, 12, 14]
      .map((i) => data.readUInt16BE(i).toString(16))
      .join(':');
  else if (type === TYPE.PTR) data = decodeName(buf, start)[0];
  else if (type === TYPE.TXT) data = decodeTxt(data);
  else if (type === TYPE.SRV && len >= 7)
    data = {
      priority: data.readUInt16BE(0),
      weight: data.readUInt16BE(2),
      port: data.readUInt16BE(4),
      target: decodeName(buf, start + 6)[0],
    };
  return [
    { name, type, ttl, flush: !!(cls & TOP_BIT), cls: cls & 0x7fff, data },
    end,
  ];
}

/** Parses a packet; throws on a malformed one */
function decodePacket(buf) {
  if (buf.length < 12) throw new RangeError('Truncated DNS packet');
  const flags = buf.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o));
  const packet = {
    id: buf.readUInt16BE(0),
    response: !!(flags & 0x8000),
    questions: [],
    answers: [],
    authorities: [],
    additionals: [],
  };
  let pos = 12;
  for (let i = 0; i < counts[0]; i++) {
    const [name, next] = decodeName(buf, pos);
    if (next + 4 > buf.length) throw new RangeError('Truncated DNS question');
    const cls = buf.readUInt16BE(next + 2);
    packet.questions.push({
      name,
      type: buf.readUInt16BE(next),
      unicast: !!(cls & TOP_BIT),
    });
    pos = next + 4;
  }
  for (const [section, n] of [
    ['answers', counts[1]],
    ['authorities', counts[2]],
    ['additionals', counts[3]],
  ]) {
    for (let i = 0; i < n; i++) {
      const [record, next] = decodeRecord(buf, pos);
      packet[section].push(record);
      pos = next;
    }
  }
  return packet;
}

// --- Browsing --------------------------------------------------------------

const lower = (s) => String(s).toLowerCase().replace(/\.$/, '');

/** IPv4 addresses of this computer's network adapters (multicast goes out
 *  of each one, or only the default one would be searched) */
function localInterfaces() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

/**
 * Looks for instances of the given service types, e.g. '_uscan._tcp.local'.
 * Calls onService({ type, instance, name, host, port, addresses, txt }) as
 * each one is fully known; resolves with all of them after timeoutMs.
 *
 * targets: [{ address, port }] to query instead of the multicast group
 * (tests run a responder on a loopback port). Rejects with the socket's
 * error (EACCES/EPERM when the system blocks local network access) if no
 * query could be sent at all.
 */
function browse({
  types,
  timeoutMs = 4000,
  onService,
  targets,
  signal,
  interfaces = localInterfaces,
}) {
  const wanted = new Set(types.map(lower));
  const ptr = new Map(); // instance -> service type
  const srv = new Map(); // instance -> { target, port }
  const txt = new Map(); // instance -> txt
  const addrs = new Map(); // host -> Set of IPv4 addresses
  const display = new Map(); // instance -> its name as spelled
  const reported = new Map(); // instance -> service
  const asked = new Set(); // follow-up questions already sent

  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4' });
    const timers = [];
    let sent = 0;
    let lastError = null;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      signal?.removeEventListener('abort', finish);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      // Ones still missing their TXT record are reported anyway
      for (const instance of ptr.keys()) report(instance, true);
      if (!sent && lastError) reject(lastError);
      else resolve([...reported.values()]);
    };

    const send = (questions) => {
      const packet = encodePacket({
        id: Math.floor(Math.random() * 0xfffe) + 1,
        questions: questions.map((q) => ({ ...q, unicast: true })),
      });
      const destinations = targets
        ? targets.map((t) => [t.address, t.port, null])
        : interfaces().map((i) => [MDNS_ADDRESS, MDNS_PORT, i]);
      for (const [address, port, iface] of destinations) {
        try {
          if (iface) sock.setMulticastInterface(iface);
          sock.send(packet, port, address, (err) => {
            if (err) lastError = err;
            else sent++;
          });
        } catch (err) {
          lastError = err;
        }
      }
    };

    function report(instance, final) {
      if (reported.has(instance)) return;
      const s = srv.get(instance);
      if (!s) return;
      const ips = addrs.get(lower(s.target));
      if (!ips?.size) return;
      if (!txt.has(instance) && !final) return;
      const type = ptr.get(instance);
      const full = display.get(instance) ?? instance;
      const service = {
        type: type.replace(/\.local$/, ''),
        instance: full,
        name: full.slice(0, full.length - type.length - 1),
        host: s.target,
        port: s.port,
        addresses: [...ips],
        txt: txt.get(instance) ?? {},
      };
      reported.set(instance, service);
      onService?.(service);
    }

    function followUp() {
      const questions = [];
      for (const instance of ptr.keys()) {
        if (reported.has(instance)) continue;
        const s = srv.get(instance);
        if (!s || !txt.has(instance)) {
          if (!asked.has(`srv ${instance}`)) {
            asked.add(`srv ${instance}`);
            questions.push(
              { name: instance, type: TYPE.SRV },
              { name: instance, type: TYPE.TXT }
            );
          }
        }
        if (s && !addrs.get(lower(s.target))?.size) {
          if (!asked.has(`a ${s.target}`)) {
            asked.add(`a ${s.target}`);
            questions.push({ name: s.target, type: TYPE.A });
          }
        }
      }
      if (questions.length) send(questions);
    }

    sock.on('message', (msg) => {
      let packet;
      try {
        packet = decodePacket(msg);
      } catch {
        return; // not ours, or broken
      }
      if (!packet.response) return;
      const records = [...packet.answers, ...packet.additionals];
      for (const r of records) {
        const name = lower(r.name);
        if (r.type === TYPE.PTR && wanted.has(name)) {
          if (r.ttl === 0) continue; // a "goodbye"
          const instance = lower(r.data);
          if (!ptr.has(instance)) ptr.set(instance, name);
          // Kept as the responder spelled it, for display
          if (!display.has(instance))
            display.set(instance, String(r.data).replace(/\.$/, ''));
        }
      }
      for (const r of records) {
        const key = lower(r.name);
        if (r.type === TYPE.SRV && ptr.has(key))
          srv.set(key, { target: r.data.target, port: r.data.port });
        else if (r.type === TYPE.TXT && ptr.has(key)) txt.set(key, r.data);
        else if (r.type === TYPE.A) {
          if (!addrs.has(key)) addrs.set(key, new Set());
          addrs.get(key).add(r.data);
        }
      }
      for (const instance of ptr.keys()) report(instance, false);
      followUp();
    });

    sock.on('error', (err) => {
      lastError = err;
      finish();
    });
    if (signal?.aborted) return finish();
    signal?.addEventListener('abort', finish);

    sock.bind(0, () => {
      try {
        sock.setMulticastTTL(255);
      } catch {
        /* some systems refuse; the default works */
      }
      const ask = () => {
        asked.clear(); // follow-ups lost the first time are asked again
        send([...wanted].map((name) => ({ name, type: TYPE.PTR })));
      };
      // Repeated, as RFC 6762 suggests, for answers lost on busy networks
      ask();
      for (const at of [1000, 2500])
        if (at < timeoutMs) timers.push(setTimeout(ask, at));
      timers.push(setTimeout(finish, timeoutMs));
    });
  });
}

module.exports = {
  browse,
  encodePacket,
  decodePacket,
  localInterfaces,
  MDNS_ADDRESS,
  MDNS_PORT,
  TYPE,
};
