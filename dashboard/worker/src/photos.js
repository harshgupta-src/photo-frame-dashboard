// iCloud Shared Album readers for links made with "Public Website" turned on. Both use the same
// unauthenticated calls as Apple's own album web page, and both return signed image URLs that expire.
//  - Current links, photos.icloud.com/shared/album/<id>: CloudKit. records/resolve on the public
//    database gives an anonymous access token for the album's shared zone, which is then queried.
//  - Older links, www.icloud.com/sharedalbum/#<token>: sharedstreams webstream + webasseturls
//    (at most 25 photos per call).
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const HEADERS = { 'Content-Type': 'text/plain', Origin: 'https://www.icloud.com', Referer: 'https://www.icloud.com/sharedalbum/' };
const MAX_PHOTOS = 500; // keeps a refresh under the Workers subrequest limit (1 + 500/25 calls)

const CK = 'https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production';
const CK_HEADERS = { 'Content-Type': 'text/plain', Origin: 'https://photos.icloud.com' };

// https://photos.icloud.com/shared/album/<id> (or share.icloud.com/photos/<id>) → <id>, else null.
export function sharedCollectionId(link) {
  const m = String(link || '').match(/^https:\/\/(?:photos\.icloud\.com\/shared\/album|share\.icloud\.com\/photos)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

async function ck(url, body) {
  const r = await fetch(url, { method: 'POST', headers: CK_HEADERS, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`iCloud shared album → HTTP ${r.status}`);
  return r.json();
}

const field = (rec, name) => rec && rec.fields && rec.fields[name] ? rec.fields[name].value : undefined;
function b64text(v) {
  try { return v ? new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0))).trim() : ''; } catch { return ''; }
}

// Minimal binary property list (bplist00) reader: dict, array, string (ASCII/UTF-16), int, real, bool,
// date, data and uid. An NSKeyedArchiver archive ($objects/$top) is unpacked into plain values.
export function parseBplist(input) {
  const u8 = input instanceof Uint8Array ? input : Uint8Array.from(input);
  if (u8.length < 40 || String.fromCharCode(...u8.subarray(0, 6)) !== 'bplist') throw new Error('not a bplist');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const t = u8.length - 32;
  const offSize = u8[t + 6], refSize = u8[t + 7];
  const uint = (pos, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u8[pos + i]; return v; };
  const count = uint(t + 8, 8), top = uint(t + 16, 8), table = uint(t + 24, 8);
  const decode = (bytes, enc) => new TextDecoder(enc).decode(bytes);
  function obj(i, depth) {
    if (depth > 64 || i >= count) throw new Error('bad bplist');
    let p = uint(table + i * offSize, offSize);
    const m = u8[p], hi = m >> 4, lo = m & 15;
    let n = lo;
    p++;
    if (lo === 15 && [4, 5, 6, 10, 13].includes(hi)) {
      const w = 1 << (u8[p] & 15);
      n = uint(p + 1, w);
      p += 1 + w;
    }
    const refs = (k) => Array.from({ length: k }, (_, j) => uint(p + j * refSize, refSize));
    switch (hi) {
      case 0: return lo === 8 ? false : lo === 9 ? true : null;
      case 1: { const w = 1 << lo; return w === 8 ? Number(dv.getBigInt64(p)) : w === 16 ? Number(dv.getBigInt64(p + 8)) : uint(p, w); }
      case 2: return (1 << lo) === 4 ? dv.getFloat32(p) : dv.getFloat64(p);
      case 3: return new Date((978307200 + dv.getFloat64(p)) * 1000);
      case 4: return u8.slice(p, p + n);
      case 5: return decode(u8.subarray(p, p + n), 'latin1');
      case 6: return decode(u8.subarray(p, p + 2 * n), 'utf-16be');
      case 8: return { UID: uint(p, lo + 1) };
      case 10: return refs(n).map((r) => obj(r, depth + 1));
      case 13: {
        const r = refs(2 * n), out = {};
        for (let j = 0; j < n; j++) out[obj(r[j], depth + 1)] = obj(r[n + j], depth + 1);
        return out;
      }
      default: throw new Error('bplist type ' + hi);
    }
  }
  const root = obj(top, 0);
  return root && Array.isArray(root.$objects) && root.$top ? unarchive(root) : root;
}

function unarchive(root) {
  const objs = root.$objects;
  const isUid = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && 'UID' in v;
  function val(v, depth) {
    if (depth > 32) return null;
    if (isUid(v)) v = objs[v.UID];
    if (v === '$null') return null;
    if (Array.isArray(v)) return v.map((x) => val(x, depth + 1));
    if (!v || typeof v !== 'object' || v instanceof Date || v instanceof Uint8Array) return v;
    if (Array.isArray(v['NS.objects'])) {
      const vals = v['NS.objects'].map((x) => val(x, depth + 1));
      if (!Array.isArray(v['NS.keys'])) return vals;
      return Object.fromEntries(v['NS.keys'].map((k, j) => [val(k, depth + 1), vals[j]]));
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) if (k !== '$class') out[k] = val(x, depth + 1);
    return out;
  }
  const t = root.$top;
  return val(t.root !== undefined ? t.root : t[Object.keys(t)[0]], 0);
}

const LAT_KEYS = ['lat', 'latitude', 'kCLLocationCodingKeyCoordinateLatitude'];
const LON_KEYS = ['lon', 'lng', 'longitude', 'kCLLocationCodingKeyCoordinateLongitude'];
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

// A CPLAsset's locationEnc (base64 bplist) → { lat, lon } rounded to 4 decimals (~11 m), or null.
export function decodeLocation(b64) {
  if (!b64) return null;
  let o;
  try { o = parseBplist(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return null; }
  const pick = (keys) => { for (const k of keys) if (o && typeof o[k] === 'number' && isFinite(o[k])) return o[k]; };
  const lat = pick(LAT_KEYS), lon = pick(LON_KEYS);
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat: round(lat, 4), lon: round(lon, 4) };
}

// Place names come from OpenStreetMap's Nominatim: free, no key, and its usage policy allows a light
// server-side load like this one (an identifying User-Agent, at most 1 request/s, results cached).
// BigDataCloud's free endpoint is meant to be called from the end user's browser, not a server.
// Coordinates are rounded to 2 decimals (~1 km) before they leave the Worker: enough for a town name.
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const GEO_UA = 'frame-data/1.0 (family photo frame; github.com/wesbos/photo-frame-dashboard)';
const GEO_TTL = 365 * 86400;
export const GEO_MAX_LOOKUPS = 15; // per refresh; see attachPlaces
export const geoKey = (lat, lon) => `geo:${lat.toFixed(2)},${lon.toFixed(2)}`;

// Nominatim address → "Brooklyn, NY", "Seattle, WA", "Lisbon, Portugal".
export function placeName(a) {
  if (!a) return '';
  const nycBorough = a.city === 'New York' && a.suburb;
  const local = nycBorough || a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.county || '';
  const us = a.country_code === 'us';
  const st = us && /^US-([A-Z]{2})$/.exec(a['ISO3166-2-lvl4'] || '');
  const region = us ? (st ? st[1] : a.state || '') : a.country || '';
  if (!local) return [a.state, a.country].filter(Boolean).join(', ');
  return region && region !== local ? `${local}, ${region}` : local;
}

// "" when the spot has no address (open sea); throws on network/HTTP errors so it is retried later.
export async function reverseGeocode(lat, lon, fetchFn = fetch) {
  const u = `${NOMINATIM}?format=jsonv2&zoom=14&addressdetails=1&accept-language=en&lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`;
  const r = await fetchFn(u, { headers: { 'User-Agent': GEO_UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`reverse geocode → HTTP ${r.status}`);
  const j = await r.json();
  return placeName(j && j.address);
}

// Sets p.place on every photo with lat/lon from the KV cache (geo:<lat>,<lon> → name). With lookups > 0,
// geocodes up to that many uncached spots first (1.1 s apart, Nominatim's rate limit) and caches them.
// Never throws: a failed lookup just leaves those photos without a place until a later refresh.
// Returns { added, missing } (spots newly named, spots still unnamed).
export async function attachPlaces(kv, photos, { lookups = 0, fetchFn = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const keys = [...new Set(photos.filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number').map((p) => geoKey(p.lat, p.lon)))];
  const names = {};
  await Promise.all(keys.map(async (k) => {
    try { const v = await kv.get(k); if (v !== null && v !== undefined) names[k] = v; } catch { /* treat as uncached */ }
  }));
  let added = 0, tries = 0;
  for (const k of keys) {
    if (k in names || tries >= lookups) continue;
    if (tries++) await wait(1100);
    const [lat, lon] = k.slice(4).split(',').map(Number);
    try {
      names[k] = await reverseGeocode(lat, lon, fetchFn);
      added++;
      await kv.put(k, names[k], { expirationTtl: GEO_TTL });
    } catch { /* retried on a later refresh */ }
  }
  for (const p of photos) {
    const k = typeof p.lat === 'number' && typeof p.lon === 'number' ? geoKey(p.lat, p.lon) : null;
    p.place = (k && names[k]) || '';
  }
  return { added, missing: keys.filter((k) => !(k in names)).length };
}

// One photo from a CPLAsset and its CPLMaster. Edited photos carry their own renders on the asset.
export function collectionPhoto(asset, master, names) {
  const pick = (res) => {
    const rec = field(asset, res + 'Res') ? asset : master;
    const v = field(rec, res + 'Res');
    return v && v.downloadURL ? { url: v.downloadURL.replace('${f}', 'photo.jpg'), w: +field(rec, res + 'Width'), h: +field(rec, res + 'Height') } : null;
  };
  const type = String(field(master, 'itemType') || '');
  if (/movie|mpeg|video|avi/i.test(type)) return null;
  const big = pick('resJPEGMed') || pick('resJPEGThumb'), small = pick('resJPEGThumb') || big;
  if (!big) return null;
  const by = asset.created && names[asset.created.userRecordName];
  const loc = decodeLocation(field(asset, 'locationEnc'));
  return {
    id: asset.recordName,
    date: new Date(+field(asset, 'assetDate') || +field(master, 'originalCreationDate') || Date.now()).toISOString(),
    w: big.w, h: big.h,
    caption: b64text(field(asset, 'captionEnc')),
    by: by || '',
    ...(loc || {}),
    url: { l: big.url, s: small.url },
  };
}

async function readSharedCollection(id) {
  const res = (await ck(`${CK}/public/records/resolve?remapEnums=true`, { shortGUIDs: [{ value: id }] })).results || [];
  const r = res[0];
  if (!r || !r.anonymousPublicAccess) throw new Error('Shared album not found. Is "Public Website" still on?');
  const names = {};
  const addName = (ident) => { if (ident && ident.userRecordName && ident.nameComponents) names[ident.userRecordName] = ident.nameComponents.givenName || ''; };
  addName(r.ownerIdentity);
  for (const p of (r.share && r.share.participants) || []) addName(p.userIdentity);

  const { token, databasePartition } = r.anonymousPublicAccess;
  const url = `${databasePartition || 'https://ckdatabasews.icloud.com'}/database/1/com.apple.photos.cloud/production/shared/records/query?remapEnums=true&publicAccessAuthToken=${encodeURIComponent(token)}`;
  const masters = {}, assets = [];
  let marker;
  for (let page = 0; page < 20 && assets.length < MAX_PHOTOS; page++) {
    const q = await ck(url, {
      query: { recordType: 'CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted', filterBy: [{ fieldName: 'direction', comparator: 'EQUALS', fieldValue: { value: 'DESCENDING', type: 'STRING' } }] },
      zoneID: r.zoneID, resultsLimit: 200, ...(marker ? { continuationMarker: marker } : {}),
    });
    for (const rec of q.records || []) {
      if (rec.recordType === 'CPLMaster') masters[rec.recordName] = rec;
      else if (rec.recordType === 'CPLAsset') assets.push(rec);
    }
    marker = q.continuationMarker;
    if (!marker) break;
  }
  const photos = assets.map((a) => {
    const ref = field(a, 'masterRef');
    return collectionPhoto(a, ref && masters[ref.recordName], names);
  }).filter(Boolean);
  return { name: (r.share && field(r.share, 'cloudkit.title')) || '', photos: photos.slice(0, MAX_PHOTOS) };
}

// Accepts the share link (https://www.icloud.com/sharedalbum/#B0aG...) or the bare token.
export function albumToken(link) {
  const s = String(link || '').trim();
  const m = s.match(/#([A-Za-z0-9]+)/);
  const t = m ? m[1] : s;
  if (!/^[A-Za-z0-9]{10,}$/.test(t)) throw new Error('Not an iCloud shared album link: ' + s.slice(0, 40));
  return t;
}

export function albumBase(token) {
  const n = (str) => [...str].reduce((acc, ch) => acc * 62 + B62.indexOf(ch), 0);
  const p = token[0] === 'A' ? n(token[1]) : n(token.slice(1, 3));
  return `https://p${String(p).padStart(2, '0')}-sharedstreams.icloud.com/${token}/sharedstreams/`;
}

async function post(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  if (r.status === 330) return { redirect: (await r.json())['X-Apple-MMe-Host'] };
  if (r.status === 404) throw new Error('Shared album not found. Is "Public Website" still on?');
  if (!r.ok) throw new Error(`iCloud shared album ${path} → HTTP ${r.status}`);
  return { data: await r.json() };
}

// Big: largest derivative up to ~2k px (the frame is 1280×800). Small: smallest that is at least 400 px.
export function pickDerivatives(derivs) {
  const list = Object.values(derivs || {}).map((d) => ({ ...d, size: Math.max(+d.width || 0, +d.height || 0) }))
    .filter((d) => d.checksum && d.size).sort((a, b) => a.size - b.size);
  if (!list.length) return null;
  const big = list.filter((d) => d.size <= 2100).pop() || list[0];
  const small = list.find((d) => d.size >= 400) || big;
  return { l: big.checksum, s: small.checksum };
}

// Returns { name, photos: [{ id, date, w, h, caption, by, lat?, lon?, url: { l, s } }] }, newest first.
// Only CloudKit albums carry a location (lat/lon); the older sharedstreams ones don't.
export async function readAlbum(link) {
  const id = sharedCollectionId(link);
  if (id) return readSharedCollection(id);
  const token = albumToken(link);
  let base = albumBase(token);
  let res = await post(base, 'webstream', { streamCtag: null });
  if (res.redirect) {
    base = `https://${res.redirect}/${token}/sharedstreams/`;
    res = await post(base, 'webstream', { streamCtag: null });
  }
  const stream = res.data;
  const photos = (stream.photos || [])
    .filter((p) => p.mediaAssetType !== 'video')
    .map((p) => ({
      id: p.photoGuid,
      date: p.dateCreated || p.batchDateCreated,
      w: +p.width, h: +p.height,
      caption: (p.caption || '').trim(),
      by: (p.contributorFirstName || p.contributorFullName || '').trim(),
      pick: pickDerivatives(p.derivatives),
    }))
    .filter((p) => p.pick)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, MAX_PHOTOS);

  const urls = {};
  for (let i = 0; i < photos.length; i += 25) {
    const r = await post(base, 'webasseturls', { photoGuids: photos.slice(i, i + 25).map((p) => p.id) });
    for (const [checksum, it] of Object.entries((r.data && r.data.items) || {})) urls[checksum] = 'https://' + it.url_location + it.url_path;
  }
  return {
    name: stream.streamName || '',
    photos: photos.map(({ pick, ...p }) => ({ ...p, url: { l: urls[pick.l], s: urls[pick.s] } })).filter((p) => p.url.l),
  };
}
