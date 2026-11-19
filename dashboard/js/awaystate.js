// Is the dog away (at a sitter / boarding)? Pure, so node --test can run it (test/awaystate.test.js).
// The same rule runs in Home Assistant (ha/maya-away.yaml, binary_sensor.maya_away), which pauses
// walk heads-ups and meal alerts; the frame works it out itself from its calendar copy so it
// doesn't depend on a sensor the kiosk doesn't stream.
//   calendar  an in-progress event whose title names the dog (or 🐕) and says sitter/boarding/kennel
//   override  input_select.maya_away_override: auto (follow the calendar), away (until changed), or
//             home (she came back early: cancels a stay that started before it was set, so a stale
//             "home" never cancels the next one)

export var SITTER_RE = /\b(sitter|boarding|boarder|boarded|kennel)\b/i;

export function isSitterEvent(e, dogName) {
  var t = (e && e.title) || '';
  var dog = new RegExp(String(dogName || 'Maya').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|🐕', 'i');
  return dog.test(t) && SITTER_RE.test(t);
}

// The stay in progress at `now` (the one ending last, if they overlap), else null.
export function currentStay(events, now, dogName) {
  var t = +now, best = null;
  (events || []).forEach(function (e) {
    if (isSitterEvent(e, dogName) && +e.start <= t && t < +e.end && (!best || +e.end > +best.end)) best = e;
  });
  return best;
}

// The next stay starting after `now` within `withinMs`, for a heads-up line.
export function nextStay(events, now, dogName, withinMs) {
  var t = +now, best = null;
  (events || []).forEach(function (e) {
    if (isSitterEvent(e, dogName) && +e.start > t && +e.start - t <= withinMs && (!best || +e.start < +best.start)) best = e;
  });
  return best;
}

// override: { state: 'auto'|'away'|'home', changed: ms } or null.
// → { away, source: 'manual'|'calendar'|'none', stay (event or null), until (Date or null), cancelled }
export function awayState(events, override, now, dogName) {
  var o = override || { state: 'auto', changed: 0 }, stay = currentStay(events, now, dogName);
  if (o.state === 'away') return { away: true, source: 'manual', stay: stay, until: stay ? stay.end : null, cancelled: false };
  if (o.state === 'home' && stay && +stay.start <= +o.changed) return { away: false, source: 'manual', stay: stay, until: null, cancelled: true };
  return { away: !!stay, source: stay ? 'calendar' : 'none', stay: stay, until: stay ? stay.end : null, cancelled: false };
}

// What tapping "She's home" / "Away" should set the override to.
export function toggleMode(state) {
  if (state.away) return state.stay ? 'home' : 'auto';
  return state.cancelled ? 'auto' : 'away';
}
