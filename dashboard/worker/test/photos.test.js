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
