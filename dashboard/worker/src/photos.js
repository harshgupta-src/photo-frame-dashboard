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
  return {
    id: asset.recordName,
    date: new Date(+field(asset, 'assetDate') || +field(master, 'originalCreationDate') || Date.now()).toISOString(),
    w: big.w, h: big.h,
    caption: b64text(field(asset, 'captionEnc')),
    by: by || '',
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

// Returns { name, photos: [{ id, date, w, h, caption, by, url: { l, s } }] }, newest first.
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
