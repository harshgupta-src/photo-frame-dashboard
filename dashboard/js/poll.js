// Polling that sleeps while the page is hidden (frame screen off, phone app in the background) and
// catches up once when it's shown again, instead of fetching into a page nobody sees.
//   every(ms, fn, { resume, delay })  runs fn every ms while visible; when the page is shown again and
//                                     a tick is due (one fell while hidden, or ms has passed since the
//                                     last run), runs resume (default fn) once, delay ms later
//                                     (stagger loaders so they don't all land in the same frame)
// Catching up is time-based: iOS Safari freezes timers while the app is in the background, so the
// interval may never have fired there. A page restored from the back/forward cache (pageshow with
// persisted) catches up the same way.
// Returns a function that stops it.
export function every(ms, fn, opts) {
  opts = opts || {};
  var doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  var win = opts.win || (typeof window !== 'undefined' ? window : null);
  var clock = opts.now || Date.now;
  var missed = false, last = clock(), pending = null;
  function run(f) { last = clock(); missed = false; f(); }
  var id = setInterval(function () {
    if (doc && doc.hidden) { missed = true; return; }
    run(fn);
  }, ms);
  function catchUp() {
    if (!doc || doc.hidden) return;
    if (!missed && clock() - last < ms) return;
    missed = false;
    if (pending) return;
    pending = setTimeout(function () { pending = null; if (!doc.hidden) run(opts.resume || fn); }, opts.delay || 0);
  }
  function onShow(e) { if (e && e.persisted) catchUp(); }
  if (doc) doc.addEventListener('visibilitychange', catchUp);
  if (win && win.addEventListener) win.addEventListener('pageshow', onShow);
  return function () {
    clearInterval(id);
    clearTimeout(pending);
    if (doc) doc.removeEventListener('visibilitychange', catchUp);
    if (win && win.removeEventListener) win.removeEventListener('pageshow', onShow);
  };
}

export function hidden() { return typeof document !== 'undefined' && !!document.hidden; }
