// Planned walks on the frame's schedule (WALKS.md, Walk plan). The Worker mirrors each planned walk
// to a calendar (UID walk-plan-<id>@frame-data), but the frame's copy of that calendar lags the plan:
// a replan moves or drops walks minutes before the next calendar fetch sees it, and a walk that was
// just logged stays "planned" there. So for the days the walk sync has fetched (App.walk.planDays),
// the schedule shows the plan itself (App.walk.plans, the same data as the walk tile) instead.
// Pure, so node --test can run it (test/planevents.test.js).

export var PLAN_UID = /(?:^|\|)walk-plan-[^|@]+@frame-data/;
export function isPlanEvent(e) { return PLAN_UID.test(String((e && e.id) || '')); }

function ymd(d) {
  d = new Date(d);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

// The schedule entries for the plan's walks still to come or missed (done and under-way ones are on
// the walk tile, and the Worker deletes their calendar events).
//   opts: { dog, isPerson(id), idOf(uid) }
export function planEvents(plans, opts) {
  var out = [];
  (plans || []).forEach(function (p) {
    (p.walks || []).forEach(function (x) {
      if (x.status !== 'planned' && x.status !== 'missed') return;
      var ids = (x.walkerIds || []).filter(opts.isPerson || function () { return true; });
      out.push({
        id: (opts.idOf || String)('walk-plan-' + x.id + '@frame-data'),
        title: '🐕 ' + opts.dog + ' walk — ' + (x.walkers || []).join(' & '),
        people: ids, allDay: false, cal: x.calendarName || opts.dog + ' walk plan',
        start: new Date(x.start), end: new Date(x.end), notes: x.note || undefined
      });
    });
  });
  return out;
}

// events: the calendar's (start/end as Dates), with the plan's calendar copies replaced by the plan
// for the days it covers (days fetched, plus any day it has a plan for). Sorted by start.
export function withPlans(events, plans, days, opts) {
  var covered = {};
  (days || []).forEach(function (d) { covered[d] = 1; });
  (plans || []).forEach(function (p) { if (p && p.date) covered[p.date] = 1; });
  var keep = (events || []).filter(function (e) { return !(isPlanEvent(e) && covered[ymd(e.start)]); });
  if (keep.length === (events || []).length && !(plans || []).length) return keep;
  return keep.concat(planEvents(plans, opts)).sort(function (a, b) { return a.start - b.start; });
}
