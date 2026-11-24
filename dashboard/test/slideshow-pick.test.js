import { test } from 'node:test';
import assert from 'node:assert/strict';

// slideshow.js attaches to window.App; give it just enough of the app to pick slides.
const photos = [];
globalThis.window = { DATA: { photos } };
globalThis.App = {
  now: () => new Date(2026, 10, 19, 14, 0),
  fmt: { month: (d) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] },
  person: (id) => id,
  esc: (s) => String(s),
  on: () => {},
  portrait: false,
};
await import('../js/slideshow.js');
const { Slideshow, photoWhere, photosWhere } = globalThis.App;

test('a collage or pair that the screen-shaped pool cannot fill falls back to one photo', () => {
  // Landscape screen, two landscape photos (the pool) and two portrait ones: the album has enough
  // for a collage but the pool does not.
  photos.splice(0, photos.length,
    { id: 'a', o: 'l', date: '2020-01-01', tag: 'x' }, { id: 'b', o: 'l', date: '2020-02-01', tag: 'y' },
    { id: 'c', o: 'p', date: '2020-03-01', tag: 'z' }, { id: 'd', o: 'p', date: '2020-04-01', tag: 'w' });
  const s = new Slideshow(null, {});
  for (let i = 0; i < 20; i++) {
    const sl = s.pick();
    assert.ok(sl.photos.every(Boolean), 'no missing photo in slide ' + i + ' (' + sl.layout + ')');
    if (sl.layout === 'collage') assert.equal(sl.photos.length, 3);
    if (sl.layout === 'pair') assert.equal(sl.photos.length, 2);
  }
});

test('place names: a caption repeating the place is dropped, several photos list each place once', () => {
  assert.equal(photoWhere({ place: 'Lisbon, Portugal', caption: 'lisbon, portugal' }), 'Lisbon, Portugal');
  assert.equal(photoWhere({ place: 'Lisbon', caption: 'Grandma' }), 'Lisbon · Grandma');
  assert.equal(photoWhere({ place: '', caption: '' }), '');
  assert.equal(photosWhere([{ place: 'Lisbon' }, { place: 'lisbon' }, { place: 'Porto' }]), 'Lisbon · Porto');
  assert.equal(photosWhere([{ place: '' }, {}]), '');
});
