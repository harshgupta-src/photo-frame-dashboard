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
  App.photoMeta = function (p) {
    var d = parseDate(p), now = App.now();
    var years = now.getFullYear() - d.getFullYear();
    var onThisDay = d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var kicker = onThisDay ? years + (years === 1 ? ' year' : ' years') + ' ago today' : (years > 0 ? years + (years === 1 ? ' year ago' : ' years ago') : 'This year');
    return {
      date: App.fmt.month(d) + ' ' + d.getDate() + ', ' + d.getFullYear(),
      monthYear: App.fmt.month(d) + ' ' + d.getFullYear(),
      kicker: kicker, onThisDay: onThisDay, place: p.place, from: App.person(p.from)
    };
  };

  // 'p' on a portrait screen, 'l' on a landscape one (photos use the same letters in p.o).
  function screenShape() { return App.portrait ? 'p' : 'l'; }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function caption(ps, size) {
    var m = App.photoMeta(ps[0]);
    return '<div class="cap cap--' + (size || 'l') + '">' +
      '<div class="cap-kicker">' + (m.onThisDay ? '<b>On this day</b> · ' : '') + m.kicker + (m.place ? ' · ' + App.esc(m.place) : '') + '</div>' +
      '<div class="cap-date serif">' + (ps.length > 1 ? m.monthYear : m.date) + '</div>' +
      '</div>';
  }
  function kb(p, still) {
    var dx = (Math.random() > 0.5 ? 1 : -1) * (1 + Math.random() * 2.5) + '%';
    var dy = (Math.random() > 0.5 ? 1 : -1) * (0.5 + Math.random() * 1.5) + '%';
    return '<div class="kb' + (still ? ' kb--still' : '') + '" style="--dx:' + dx + ';--dy:' + dy + '"><img src="' + src(p, true) + '" alt=""></div>';
  }

  var BUILD = {
    // A photo the same shape as the screen fills it; the other shape is fitted over a blurred copy.
    cover: function (ps, o) {
      var p = ps[0];
      if (p.o !== screenShape()) {
        return '<div class="slide slide--fit"><img class="blurfill" src="' + src(p) + '" alt=""><img class="fitimg" src="' + src(p, true) + '" alt="">' + (o.captions ? caption(ps) : '') + '</div>';
      }
      return '<div class="slide slide--cover">' + kb(p) + (o.captions ? caption(ps) : '') + '</div>';
    },
    pair: function (ps, o) {
      return '<div class="slide slide--pair"><div class="pane">' + kb(ps[0], true) + '</div><div class="pane">' + kb(ps[1], true) + '</div>' + (o.captions ? caption(ps, 'm') : '') + '</div>';
    },
    collage: function (ps, o) {
      return '<div class="slide slide--collage"><div class="pane pane--a">' + kb(ps[0], true) + '</div><div class="pane pane--b">' + kb(ps[1], true) + '</div><div class="pane pane--c">' + kb(ps[2], true) + '</div>' + (o.captions ? caption(ps, 'm') : '') + '</div>';
    },
    polaroid: function (ps) {
      var p = ps[0], m = App.photoMeta(p), rot = (Math.random() * 5 - 2.5).toFixed(1);
      return '<div class="slide slide--polaroid"><img class="blurfill" src="' + src(p) + '" alt="">' +
        '<figure class="polaroid polaroid--' + p.o + '" style="transform:rotate(' + rot + 'deg)"><div class="polaroid-img"><img src="' + src(p, true) + '" alt=""></div>' +
        '<figcaption class="serif"><i>' + (m.place ? App.esc(m.place) + ', ' : '') + m.monthYear + '</i></figcaption></figure></div>';
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
    var self = this;
    // Rotated: the slide on screen was picked for the old shape. Pick again (now, if running).
    App.on('orient', function () {
      self.history = [];
      self.queue = [];
      if (self.timer) self.next();
      else { self.current = null; self.el.innerHTML = ''; }
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
    var q = [];
    this.ver = App.photosVer;
    this.pool().forEach(function (p) { q.push(p); if (p.fav) q.push(p); });
    // On-this-day photos always come first in a fresh cycle
    shuffle(q).sort(function (a, b) { return (App.photoMeta(b).onThisDay ? 1 : 0) - (App.photoMeta(a).onThisDay ? 1 : 0); });
    this.queue = q;
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
    if (layout === 'pair') {
      if (first.o !== odd) { first = sibling(function (x) { return x.o === odd; }); ps = [first]; }
      ps.push(sibling(function (x) { return x !== first && x.o === odd && x.tag === first.tag; }) || sibling(function (x) { return x !== first && x.o === odd; }));
    }
    if (layout === 'collage') {
      ps.push(sibling(function (x) { return x !== first; }));
      ps.push(sibling(function (x) { return ps.indexOf(x) < 0; }));
    }
    return { layout: layout, photos: ps };
  };

  S.render = function (slide) {
    var self = this;
    this.current = slide;
    var wrap = document.createElement('div');
    wrap.innerHTML = BUILD[slide.layout](slide.photos, this.o);
    var node = wrap.firstChild;
    node.style.opacity = '0';
    // Fallback look if images can't load (offline)
    Array.prototype.forEach.call(node.querySelectorAll('img'), function (im) {
      im.addEventListener('error', function () { im.classList.add('is-broken'); });
    });
    var old = Array.prototype.slice.call(this.el.children);
    this.el.appendChild(node);
    var first = node.querySelector('img:not(.blurfill)');
    var shown = false;
    function show() {
      if (shown) return; shown = true;
      node.classList.add('is-in');
      node.style.opacity = '';
      old.forEach(function (o) { o.remove(); });
    }
    if (first && !first.complete) { first.addEventListener('load', show); first.addEventListener('error', show); setTimeout(show, 2500); }
    else show();
    if (this.o.onChange) this.o.onChange(slide);
  };

  S.next = function () {
    var s = this.pick();
    if (!s) { this.restart(); return; }
    if (this.current) this.history.push(this.current);
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
})();
