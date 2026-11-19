// Polling that sleeps while the page is hidden (frame screen off, phone app in the background) and
// catches up once when it's shown again, instead of fetching into a page nobody sees.
//   every(ms, fn, { resume, delay })  runs fn every ms while visible; a tick that fell while hidden
//                                     runs resume (default fn) once, delay ms after becoming visible
//                                     (stagger loaders so they don't all land in the same frame)
// Returns a function that stops it.
export function every(ms, fn, opts) {
  opts = opts || {};
  var doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  var missed = false;
  var id = setInterval(function () {
    if (doc && doc.hidden) { missed = true; return; }
    fn();
  }, ms);
  function onVis() {
    if (!doc || doc.hidden || !missed) return;
    missed = false;
    setTimeout(function () { if (!doc.hidden) (opts.resume || fn)(); }, opts.delay || 0);
  }
  if (doc) doc.addEventListener('visibilitychange', onVis);
  return function () {
    clearInterval(id);
    if (doc) doc.removeEventListener('visibilitychange', onVis);
  };
}

export function hidden() { return typeof document !== 'undefined' && !!document.hidden; }
