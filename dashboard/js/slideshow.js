// Photo slideshow used by the Photos view, ambient mode and the home tile.
(function () {
  'use strict';
  var D = window.DATA;
  App.photosVer = App.photosVer || 0; // bumped when the photo list is replaced, so queues refill

  function src(p, big) {
    if (p.url) return big ? p.url.l : p.url.s;
    var w = p.o === 'p' ? 800 : 1600, h = p.o === 'p' ? 1200 : 1000;
    if (!big) { w = Math.round(w / 2); h = Math.round(h / 2); }
    return App.img(p.seed, w, h);
  }
  App.photoSrc = src;

  function parseDate(p) { var a = p.date.split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
  function leap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  // Memories, as in Apple Photos: a photo taken on today's month and day in an earlier year is "on
  // this day"; one within MEMORY_DAYS of it is from "this week". The anniversary nearest today is
  // used, across the year end (Dec 30 is 3 days from Jan 2), and a Feb 29 photo has its anniversary
  // on Feb 28 in other years. years: whole years back to that anniversary (0: not a memory).
  var MEMORY_DAYS = 3;
  function memory(d, now) {
    var y = now.getFullYear(), today = Date.UTC(y, now.getMonth(), now.getDate()), best = null;
    for (var k = -1; k <= 1; k++) {
      var day = d.getMonth() === 1 && d.getDate() === 29 && !leap(y + k) ? 28 : d.getDate();
      var gap = Math.round(Math.abs(Date.UTC(y + k, d.getMonth(), day) - today) / 86400000);
      if (!best || gap < best.gap) best = { gap: gap, years: y + k - d.getFullYear() };
    }
    var on = best.years > 0 && best.gap <= MEMORY_DAYS;
    return { years: on ? best.years : 0, onThisDay: on && best.gap === 0, thisWeek: on };
  }
  App.photoMemory = function (p, now) { return memory(parseDate(p), now || App.now()); };

  App.photoMeta = function (p) {
    var d = parseDate(p), now = App.now(), mem = memory(d, now);
    var years = now.getFullYear() - d.getFullYear();
    var kicker = mem.onThisDay ? plural(mem.years, 'year') + ' ago today'
      : mem.thisWeek ? plural(mem.years, 'year') + ' ago this week'
      : years > 0 ? plural(years, 'year') + ' ago' : 'This year';
    return {
      date: App.fmt.month(d) + ' ' + d.getDate() + ', ' + d.getFullYear(),
      monthYear: App.fmt.month(d) + ' ' + d.getFullYear(),
      kicker: kicker, onThisDay: mem.onThisDay, thisWeek: mem.thisWeek,
      place: p.place || '', caption: p.caption || '', from: App.person(p.from)
    };
  };
  // Place and the photo's own caption, for one line: "Lisbon, Portugal · Grandma's 80th".
  // A caption that only repeats the place is left out.
  App.photoWhere = function (m) {
    var place = String(m.place || '').trim(), cap = String(m.caption || '').trim();
    if (cap.length > 60 || cap.toLowerCase() === place.toLowerCase()) cap = '';
    return [place, cap].filter(Boolean).join(' · ');
  };
  // Several photos on one slide: each distinct place once ("Lisbon · Porto"), at most two.
  App.photosWhere = function (ps) {
    var seen = {}, out = [];
    ps.forEach(function (p) {
      var pl = String(p.place || '').trim(), k = pl.toLowerCase();
      if (pl && !seen[k]) { seen[k] = 1; out.push(pl); }
    });
    return out.slice(0, 2).join(' · ');
  };

  // One cycle of the slideshow. Each photo appears once; on-this-day photos 4 times, this-week ones
  // twice, favourites once more. A photo's copies are spread evenly through the cycle (never two in a
  // row when it can be helped), and the on-this-day photos open it. rand: Math.random (tests seed it).
  App.photoQueue = function (pool, now, rand) {
    rand = rand || Math.random;
    var singles = [], multi = [], items = [], first = [], rest = [], total = 0;
    pool.forEach(function (p) {
      var mem = memory(parseDate(p), now), n = (mem.onThisDay ? 4 : mem.thisWeek ? 2 : 1) + (p.fav ? 1 : 0);
      (n > 1 ? multi : singles).push({ p: p, n: n, lead: mem.onThisDay });
      total += n;
    });
    // Singles evenly through the cycle in random order; each photo with n copies at n evenly spaced
    // spots from a random start. So two copies have about singles/n photos between them.
    shuffle(singles, rand).forEach(function (it, i) { items.push({ p: it.p, k: (i + rand()) * total / singles.length }); });
    multi.forEach(function (it) {
      var off = rand();
      for (var j = 0; j < it.n; j++) items.push({ p: it.p, k: (j + off) * total / it.n, lead: it.lead && j === 0 });
    });
    items.sort(function (a, b) { return a.k - b.k; });
    items.forEach(function (it) { (it.lead ? first : rest).push(it.p); });
    var q = first.concat(rest);
    // The same photo twice in a row: pull the next different photo in between. If only copies of it
    // are left, put this one back earlier, between two other photos.
    for (var i = 1; i < q.length; i++) {
      if (q[i] !== q[i - 1]) continue;
      var j = i + 1;
      while (j < q.length && q[j] === q[i]) j++;
      if (j < q.length) { q.splice(i, 0, q.splice(j, 1)[0]); continue; }
      var moved = false;
      for (var k = 1; k < i && !moved; k++) {
        if (q[k - 1] !== q[i] && q[k] !== q[i]) { q.splice(k, 0, q.splice(i, 1)[0]); moved = true; }
      }
      if (!moved) break;
    }
    return q;
  };

  function shuffle(a, rand) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // 'p' on a portrait screen, 'l' on a landscape one (photos use the same letters in p.o).
  function screenShape() { return App.portrait ? 'p' : 'l'; }

  function caption(ps, size) {
    var m = App.photoMeta(ps[0]), where = ps.length > 1 ? App.photosWhere(ps) : App.photoWhere(m);
    return '<div class="cap cap--' + (size || 'l') + '">' +
      '<div class="cap-kicker">' + (m.onThisDay ? '<b>On this day</b> · ' : '') + m.kicker + (where ? ' · ' + App.esc(where) : '') + '</div>' +
      '<div class="cap-date serif">' + (ps.length > 1 ? m.monthYear : m.date) + '</div>' +
      '</div>';
  }
  // decoding="async": the 1536×2048 originals decode off the main thread. o.small: a small tile (the
  // Today photo) gets the small derivative (url.s, 360×480) instead of the full-screen one.
  function img(p, o, cls) {
    return '<img' + (cls ? ' class="' + cls + '"' : '') + ' src="' + src(p, !o.small) + '" alt="" decoding="async">';
  }
  function kb(p, o, still) {
    var dx = (Math.random() > 0.5 ? 1 : -1) * (1 + Math.random() * 2.5) + '%';
    var dy = (Math.random() > 0.5 ? 1 : -1) * (0.5 + Math.random() * 1.5) + '%';
    return '<div class="kb' + (still ? ' kb--still' : '') + '" style="--dx:' + dx + ';--dy:' + dy + '">' + img(p, o) + '</div>';
  }

  // (The blurred backdrop copies these layouts once had are hidden by the CSS, so they're not built:
  // each would be one more image to fetch and keep.)
  var BUILD = {
    // A photo the same shape as the screen fills it; the other shape is fitted on black.
    cover: function (ps, o) {
      var p = ps[0];
      if (p.o !== screenShape()) {
        return '<div class="slide slide--fit">' + img(p, o, 'fitimg') + (o.captions ? caption(ps) : '') + '</div>';
      }
      return '<div class="slide slide--cover">' + kb(p, o) + (o.captions ? caption(ps) : '') + '</div>';
    },
    pair: function (ps, o) {
      return '<div class="slide slide--pair"><div class="pane">' + kb(ps[0], o, true) + '</div><div class="pane">' + kb(ps[1], o, true) + '</div>' + (o.captions ? caption(ps, 'm') : '') + '</div>';
    },
    collage: function (ps, o) {
      return '<div class="slide slide--collage"><div class="pane pane--a">' + kb(ps[0], o, true) + '</div><div class="pane pane--b">' + kb(ps[1], o, true) + '</div><div class="pane pane--c">' + kb(ps[2], o, true) + '</div>' + (o.captions ? caption(ps, 'm') : '') + '</div>';
    },
    polaroid: function (ps, o) {
      var p = ps[0], m = App.photoMeta(p), where = App.photoWhere(m), rot = (Math.random() * 5 - 2.5).toFixed(1);
      return '<div class="slide slide--polaroid">' +
        '<figure class="polaroid polaroid--' + p.o + '" style="transform:rotate(' + rot + 'deg)"><div class="polaroid-img">' + img(p, o) + '</div>' +
        '<figcaption class="serif"><i>' + (where ? App.esc(where) + ', ' : '') + m.monthYear + '</i></figcaption></figure></div>';
    }
  };

  App.Slideshow = function (el, opts) {
    this.el = el;
    this.o = Object.assign({ layout: 'auto', interval: 15000, captions: true }, opts || {});
    this.queue = [];
    this.history = [];
    this.count = 0;
    this.timer = null;
    this.current = null;
    this.seq = 0; // bumped by every render and clear(), so a stale image load can't swap in
    var self = this;
    // Rotated: the slide on screen was picked for the old shape. Pick again (now, if running).
    App.on('orient', function () {
      self.history = [];
      self.queue = [];
      if (self.timer) self.next();
      else self.clear();
    });
  };
  var S = App.Slideshow.prototype;

  // Only photos the same shape as the screen (portrait photos on a portrait screen, landscape on
  // landscape). A chosen Pair layout needs the other shape, so it gets the whole album. Falls back
  // to the whole album when no photo matches.
  S.pool = function () {
    if (this.o.layout === 'pair') return D.photos;
    var shape = screenShape();
    var m = D.photos.filter(function (x) { return x.o === shape; });
    return m.length ? m : D.photos;
  };
  S.refill = function () {
    this.ver = App.photosVer;
    this.queue = App.photoQueue(this.pool(), App.now());
  };
  S.take = function (pred) {
    if (!this.queue.length || this.ver !== App.photosVer) this.refill();
    for (var i = 0; i < this.queue.length; i++) if (!pred || pred(this.queue[i])) return this.queue.splice(i, 1)[0];
    return null;
  };
  S.pick = function () {
    var layout = this.o.layout, n = this.count++;
    var first = this.take();
    if (!first) return null;
    var self = this;
    function sibling(pred) {
      return self.take(pred) || self.pool().filter(function (x) { return x !== first && pred(x); })[0];
    }
    // A pair puts two photos of the other shape side by side (landscape screen) or one above the
    // other (portrait screen), so together they fill the screen.
    var odd = App.portrait ? 'l' : 'p';
    if (layout === 'auto') {
      if (first.o === odd) layout = D.photos.some(function (x) { return x !== first && x.tag === first.tag; }) ? 'pair' : 'polaroid';
      else layout = n % 5 === 3 ? 'collage' : n % 5 === 4 ? 'polaroid' : 'cover';
    }
    var ps = [first];
    // Small albums: fall back when there aren't enough photos for the layout.
    var odds = D.photos.filter(function (x) { return x.o === odd; }).length;
    if (layout === 'pair' && odds < 2) layout = first.o === odd ? 'polaroid' : 'cover';
    if (layout === 'collage' && D.photos.length < 3) layout = 'cover';
    if (layout === 'pair' && first.o !== odd) {
      var o1 = sibling(function (x) { return x.o === odd; });
      if (o1) { first = o1; ps = [first]; } else layout = 'cover';
    }
    if (layout === 'pair') {
      ps.push(sibling(function (x) { return x !== first && x.o === odd && x.tag === first.tag; }) || sibling(function (x) { return x !== first && x.o === odd; }));
    }
    if (layout === 'collage') {
      ps.push(sibling(function (x) { return x !== first; }));
      ps.push(sibling(function (x) { return ps.indexOf(x) < 0; }));
    }
    // The pool (this screen's shape) can be smaller than the album: with no photo left to fill a pair
    // or collage, show the first one alone rather than build a slide around a missing photo.
    ps = ps.filter(Boolean);
    if ((layout === 'pair' && ps.length < 2) || (layout === 'collage' && ps.length < 3)) {
      ps = ps.slice(0, 1);
      if (!ps.length) return null;
      layout = ps[0].o === odd ? 'polaroid' : 'cover';
    }
    return { layout: layout, photos: ps };
  };

  // The next slide is built off-screen and swapped in, in one step, once its images are decoded
  // (or failed, or after 2.5 s): the stage never holds more than the slide on screen plus the one
  // loading, and never paints two full-screen photos on top of each other.
  S.render = function (slide) {
    var self = this;
    this.abort();
    var seq = ++this.seq;
    this.current = slide;
    var wrap = document.createElement('div');
    wrap.innerHTML = BUILD[slide.layout](slide.photos, this.o);
    var node = wrap.firstChild;
    var imgs = Array.prototype.slice.call(node.querySelectorAll('img'));
    // Fallback look if images can't load (offline)
    imgs.forEach(function (im) { im.addEventListener('error', function () { im.classList.add('is-broken'); }); });
    this.loading = imgs;
    var shown = false;
    function show() {
      if (shown) return; shown = true;
      clearTimeout(late);
      if (seq !== self.seq) return; // superseded or cleared meanwhile
      self.loading = null;
      var old = Array.prototype.slice.call(self.el.children);
      self.el.appendChild(node);
      old.forEach(function (o) { o.remove(); });
      if (self.o.onChange) self.o.onChange(slide);
    }
    var late = setTimeout(show, 2500);
    Promise.all(imgs.map(ready)).then(show, show);
  };
  // A slide still loading when the next one is asked for (or the show is cleared) is dropped, and its
  // downloads cancelled.
  S.abort = function () {
    (this.loading || []).forEach(function (im) { im.removeAttribute('src'); });
    this.loading = null;
  };
  function ready(im) {
    if (im.decode) return im.decode().catch(function () { /* broken or not decodable: show anyway */ });
    return new Promise(function (res) {
      if (im.complete) res();
      else { im.addEventListener('load', res); im.addEventListener('error', res); }
    });
  }

  S.next = function () {
    var s = this.pick();
    if (!s) { this.restart(); return; }
    if (this.current) {
      this.history.push(this.current);
      if (this.history.length > 50) this.history.shift(); // ambient runs for hours
    }
    this.render(s);
    this.restart();
  };
  S.prev = function () {
    if (!this.history.length) return;
    this.render(this.history.pop());
    this.restart();
  };
  S.setLayout = function (l) { this.o.layout = l; this.queue = []; this.next(); };
  S.restart = function () {
    var self = this;
    clearInterval(this.timer);
    this.timer = setInterval(function () { self.next(); }, this.o.interval);
  };
  S.start = function () { if (!this.current) this.next(); else this.restart(); };
  S.stop = function () { clearInterval(this.timer); this.timer = null; };
  // Stop and let go of the images (hidden view, ambient off, night). start() picks a new slide.
  S.clear = function () {
    this.stop();
    this.abort();
    this.seq++;
    this.current = null;
    this.el.textContent = '';
  };
})();
