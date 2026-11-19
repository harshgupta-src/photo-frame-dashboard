import { test } from 'node:test';
import assert from 'node:assert/strict';
import { albumToken, albumBase, pickDerivatives } from '../src/photos.js';

test('album link → token → partition host', () => {
  const t = albumToken('https://www.icloud.com/sharedalbum/#B0aGWZuqDGxyz12');
  assert.equal(t, 'B0aGWZuqDGxyz12');
  assert.equal(albumBase(t), 'https://p36-sharedstreams.icloud.com/B0aGWZuqDGxyz12/sharedstreams/');
  assert.equal(albumBase('A5abcdefghijk'), 'https://p05-sharedstreams.icloud.com/A5abcdefghijk/sharedstreams/');
  assert.throws(() => albumToken('https://example.com/'));
});

test('picks a ~2k derivative for display and a small one for the blurred fill', () => {
  const d = {
    342: { checksum: 'thumb', width: '342', height: '256' },
    2049: { checksum: 'big', width: '2048', height: '1536' },
    4032: { checksum: 'orig', width: '4032', height: '3024' },
  };
  assert.deepEqual(pickDerivatives(d), { l: 'big', s: 'big' });
  assert.deepEqual(pickDerivatives({ ...d, 1024: { checksum: 'mid', width: '1024', height: '768' } }), { l: 'big', s: 'mid' });
  assert.deepEqual(pickDerivatives({ 4032: d[4032] }), { l: 'orig', s: 'orig' });
  assert.equal(pickDerivatives({}), null);
});

test('new-style album links and CloudKit asset/master → photo', async () => {
  const { sharedCollectionId, collectionPhoto } = await import('../src/photos.js');
  assert.equal(sharedCollectionId('https://photos.icloud.com/shared/album/0aBcDeFgHiJkLmNoPqRsTuVwX'), '0aBcDeFgHiJkLmNoPqRsTuVwX');
  assert.equal(sharedCollectionId('https://www.icloud.com/sharedalbum/#B0aGWZuqDGxyz12'), null);
  const res = (u, w, h) => ({ Res: { value: { downloadURL: `https://x/${u}/\${f}?e=1` } }, Width: { value: w }, Height: { value: h } });
  const f = (prefix, r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [prefix + k, v]));
  const master = { fields: { itemType: { value: 'public.heic' }, ...f('resJPEGMed', res('med', 2048, 1536)), ...f('resJPEGThumb', res('thumb', 480, 360)) } };
  const asset = { recordName: 'A1', created: { userRecordName: '_u1' }, fields: { assetDate: { value: 1793138160473 }, ...f('resJPEGMed', res('edited', 1536, 2048)) } };
  const p = collectionPhoto(asset, master, { _u1: 'Alex' });
  assert.deepEqual(p.url, { l: 'https://x/edited/photo.jpg?e=1', s: 'https://x/thumb/photo.jpg?e=1' });
  assert.equal(p.w, 1536); assert.equal(p.by, 'Alex'); assert.equal(p.date, new Date(1793138160473).toISOString());
  assert.equal(collectionPhoto(asset, { fields: { itemType: { value: 'com.apple.quicktime-movie' } } }, {}), null);
});

// A tiny bplist00 writer for fixtures: objects are { t: 'dict'|'arr'|'str'|'real'|'int'|'date'|'uid'|'bool', v }.
function bplist(root) {
  const objs = [], parts = [];
  const add = (o) => { const i = objs.length; objs.push(o); if (o.t === 'dict') o.refs = [...Object.keys(o.v).map((k) => add({ t: 'str', v: k })), ...Object.values(o.v).map(add)]; if (o.t === 'arr') o.refs = o.v.map(add); return i; };
  add(root);
  const head = (hi, n) => (n < 15 ? [hi << 4 | n] : [hi << 4 | 15, 0x11, n >> 8, n & 255]);
  const f64 = (x) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); return [...new Uint8Array(b.buffer)]; };
  const enc = (o) => {
    switch (o.t) {
      case 'str': return /^[\x00-\x7f]*$/.test(o.v) ? [...head(5, o.v.length), ...Buffer.from(o.v, 'latin1')] : [...head(6, o.v.length), ...Buffer.from(o.v, 'utf16le').swap16()];
      case 'real': return [0x23, ...f64(o.v)];
      case 'date': return [0x33, ...f64(o.v)];
      case 'int': return [0x11, o.v >> 8, o.v & 255];
      case 'bool': return [o.v ? 9 : 8];
      case 'uid': return [0x80, o.v];
      case 'arr': return [...head(10, o.v.length), ...o.refs];
      case 'dict': return [...head(13, Object.keys(o.v).length), ...o.refs];
    }
  };
  const offsets = [];
  let pos = 8;
  for (const o of objs) { offsets.push(pos); const b = enc(o); parts.push(...b); pos += b.length; }
  const trailer = new Uint8Array(32), dv = new DataView(trailer.buffer);
  trailer[6] = 2; trailer[7] = 1;
  dv.setBigUint64(8, BigInt(objs.length)); dv.setBigUint64(24, BigInt(pos));
  const table = offsets.flatMap((o) => [o >> 8, o & 255]);
  return Uint8Array.from([...Buffer.from('bplist00'), ...parts, ...table, ...trailer]);
}
const r = (v) => ({ t: 'real', v }), s = (v) => ({ t: 'str', v });
// The shape of a real CPLAsset locationEnc (coordinates made up).
const LOCATION = { t: 'dict', v: { course: r(-1), speed: r(0), alt: r(12.5), lon: r(-9.139234), vertAcc: r(4), lat: r(38.722251), timestamp: { t: 'date', v: 800000000 }, horzAcc: r(5) } };

test('decodes a CloudKit locationEnc bplist to rounded lat/lon', async () => {
  const { parseBplist, decodeLocation } = await import('../src/photos.js');
  const bytes = bplist(LOCATION);
  const o = parseBplist(bytes);
  assert.equal(o.lat, 38.722251); assert.equal(o.alt, 12.5);
  assert.equal(o.timestamp.toISOString(), new Date((978307200 + 800000000) * 1000).toISOString());
  assert.deepEqual(decodeLocation(Buffer.from(bytes).toString('base64')), { lat: 38.7223, lon: -9.1392 });
  assert.equal(decodeLocation(''), null);
  assert.equal(decodeLocation(Buffer.from('not a plist at all, really not one').toString('base64')), null);
  assert.equal(decodeLocation(Buffer.from(bplist({ t: 'dict', v: { lat: r(0), lon: r(0) } })).toString('base64')), null);
  // Other types: arrays, ints, bools, UTF-16 strings.
  assert.deepEqual(parseBplist(bplist({ t: 'arr', v: [{ t: 'int', v: 300 }, { t: 'bool', v: true }, s('Café ☕')] })), [300, true, 'Café ☕']);
});

test('unpacks an NSKeyedArchiver location', async () => {
  const { parseBplist } = await import('../src/photos.js');
  const u = (v) => ({ t: 'uid', v });
  const archive = { t: 'dict', v: {
    $archiver: s('NSKeyedArchiver'), $version: { t: 'int', v: 100000 },
    $top: { t: 'dict', v: { root: u(1) } },
    $objects: { t: 'arr', v: [s('$null'), { t: 'dict', v: { 'NS.keys': { t: 'arr', v: [u(2), u(3)] }, 'NS.objects': { t: 'arr', v: [u(4), u(5)] }, $class: u(6) } }, s('lat'), s('lon'), r(40.5), r(-73.25), { t: 'dict', v: { $classname: s('NSDictionary') } }] },
  } };
  assert.deepEqual(parseBplist(bplist(archive)), { lat: 40.5, lon: -73.25 });
});

test('CloudKit asset with a location → photo with lat/lon', async () => {
  const { collectionPhoto } = await import('../src/photos.js');
  const master = { fields: { itemType: { value: 'public.jpeg' }, resJPEGMedRes: { value: { downloadURL: 'https://x/m/${f}' } }, resJPEGMedWidth: { value: 4 }, resJPEGMedHeight: { value: 3 } } };
  const asset = { recordName: 'A2', fields: { assetDate: { value: 1 }, locationEnc: { value: Buffer.from(bplist(LOCATION)).toString('base64'), type: 'ENCRYPTED_BYTES' } } };
  const p = collectionPhoto(asset, master, {});
  assert.equal(p.lat, 38.7223); assert.equal(p.lon, -9.1392);
  assert.equal('lat' in collectionPhoto({ ...asset, fields: { assetDate: { value: 1 } } }, master, {}), false);
});

test('Nominatim addresses → short place names', async () => {
  const { placeName } = await import('../src/photos.js');
  assert.equal(placeName({ suburb: 'Brooklyn', county: 'Kings County', city: 'New York', state: 'New York', 'ISO3166-2-lvl4': 'US-NY', country: 'United States', country_code: 'us' }), 'Brooklyn, NY');
  assert.equal(placeName({ suburb: 'First Hill', city: 'Seattle', state: 'Washington', 'ISO3166-2-lvl4': 'US-WA', country_code: 'us' }), 'Seattle, WA');
  assert.equal(placeName({ village: 'Arroios', city: 'Lisbon', county: 'Lisbon', country: 'Portugal', country_code: 'pt' }), 'Lisbon, Portugal');
  assert.equal(placeName({ town: 'Hallstatt', state: 'Upper Austria', country: 'Austria', country_code: 'at' }), 'Hallstatt, Austria');
  assert.equal(placeName({ city: 'Singapore', country: 'Singapore', country_code: 'sg' }), 'Singapore');
  assert.equal(placeName({ state: 'Alaska', country: 'United States', country_code: 'us' }), 'Alaska, United States');
  assert.equal(placeName(undefined), '');
});

function memKV(init = {}) {
  const m = new Map(Object.entries(init)), puts = [];
  return { m, puts, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v, o) => { puts.push([k, o]); m.set(k, v); } };
}

test('places come from the KV cache; uncached spots are geocoded up to the cap, failures retried later', async () => {
  const { attachPlaces, geoKey } = await import('../src/photos.js');
  const photos = [{ id: 'a', lat: 40.6782, lon: -73.9442 }, { id: 'b', lat: 40.6789, lon: -73.9401 }, { id: 'c', lat: 38.72, lon: -9.14 }, { id: 'd', lat: 47.6, lon: -122.3 }, { id: 'e', lat: 10, lon: 10 }, { id: 'f' }];
  assert.equal(geoKey(40.6782, -73.9442), 'geo:40.68,-73.94');
  const kv = memKV({ 'geo:40.68,-73.94': 'Brooklyn, NY' });
  const urls = [], waits = [];
  const fetchFn = async (u, o) => {
    urls.push(u);
    assert.match(o.headers['User-Agent'], /frame-data/);
    if (u.includes('lat=47.60')) return new Response('busy', { status: 503 });
    return Response.json({ address: { city: 'Lisbon', country: 'Portugal', country_code: 'pt' } });
  };
  // No lookups allowed: only cached names.
  assert.deepEqual(await attachPlaces(kv, photos), { added: 0, missing: 3 });
  assert.deepEqual(photos.map((p) => p.place), ['Brooklyn, NY', 'Brooklyn, NY', '', '', '', '']);
  assert.equal(urls.length, 0);
  // Two lookups allowed: Lisbon is named and cached for a year; Seattle's lookup fails and stays uncached.
  const res = await attachPlaces(kv, photos, { lookups: 2, fetchFn, wait: async (ms) => waits.push(ms) });
  assert.deepEqual(res, { added: 1, missing: 2 });
  assert.equal(urls.length, 2); assert.deepEqual(waits, [1100]);
  assert.match(urls[0], /lat=38\.72&lon=-9\.14$/);
  assert.equal(photos[2].place, 'Lisbon, Portugal'); assert.equal(photos[3].place, '');
  assert.deepEqual(kv.puts, [['geo:38.72,-9.14', { expirationTtl: 365 * 86400 }]]);
  // A broken KV or fetch never throws.
  const broken = { get: async () => { throw new Error('kv'); }, put: async () => { throw new Error('kv'); } };
  assert.deepEqual(await attachPlaces(broken, photos, { lookups: 1, fetchFn: async () => { throw new Error('net'); }, wait: async () => {} }), { added: 0, missing: 4 });
});

test('/photos returns place names (not coordinates) and names new spots in the background', async () => {
  const { default: worker } = await import('../src/index.js');
  const kv = memKV({ 'geo:38.72,-9.14': 'Lisbon, Portugal' });
  kv.get = async (k, type) => (kv.m.has(k) ? (type === 'json' ? JSON.parse(kv.m.get(k)) : kv.m.get(k)) : null);
  const env = { READ_KEY: 'k', PHOTO_ALBUM: 'https://photos.icloud.com/shared/album/ALBUM1', DATA: kv };
  const loc = (lat, lon) => Buffer.from(bplist({ t: 'dict', v: { lat: r(lat), lon: r(lon) } })).toString('base64');
  const master = (n) => ({ recordType: 'CPLMaster', recordName: 'm' + n, fields: { itemType: { value: 'public.jpeg' }, resJPEGMedRes: { value: { downloadURL: 'https://img/' + n + '/${f}' } }, resJPEGMedWidth: { value: 4 }, resJPEGMedHeight: { value: 3 } } });
  const asset = (n, enc) => ({ recordType: 'CPLAsset', recordName: 'a' + n, fields: { assetDate: { value: 1e12 }, masterRef: { value: { recordName: 'm' + n } }, ...(enc ? { locationEnc: { value: enc } } : {}) } });
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (u) => {
    u = String(u); calls.push(u);
    if (u.includes('/records/resolve')) return Response.json({ results: [{ anonymousPublicAccess: { token: 't' }, zoneID: {} }] });
    if (u.includes('/records/query')) return Response.json({ records: [master(1), asset(1, loc(38.7212, -9.1412)), master(2), asset(2, loc(40.6782, -73.9442)), master(3), asset(3)] });
    if (u.includes('nominatim')) return Response.json({ address: { suburb: 'Brooklyn', city: 'New York', 'ISO3166-2-lvl4': 'US-NY', country_code: 'us' } });
    throw new Error('unexpected ' + u);
  };
  try {
    const waits = [];
    const res = await worker.fetch(new Request('https://f.example/photos', { headers: { 'X-Frame-Key': 'k' } }), env, { waitUntil: (p) => waits.push(p) });
    const j = await res.json();
    assert.deepEqual(j.photos.map((p) => [p.id, p.place, 'lat' in p, 'url' in p]), [['a1', 'Lisbon, Portugal', false, false], ['a2', '', false, false], ['a3', '', false, false]]);
    assert.equal(waits.length, 1);
    await Promise.all(waits);
    assert.equal(calls.filter((u) => u.includes('nominatim')).length, 1);
    const again = await (await worker.fetch(new Request('https://f.example/photos', { headers: { 'X-Frame-Key': 'k' } }), env, { waitUntil: () => assert.fail('cached') })).json();
    assert.deepEqual(again.photos.map((p) => p.place), ['Lisbon, Portugal', 'Brooklyn, NY', '']);
  } finally {
    globalThis.fetch = real;
  }
});
