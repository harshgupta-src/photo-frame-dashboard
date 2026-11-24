// What a walk probably brings (pee, poop): the end-of-walk sheet's defaults. Pure and dependency-free,
// so the Worker (planJSON, /walks/stop) and the frame (js/walk.js) share it.
//   1. the plan says so: the HA agent's per-walk expect {pee, poop}
//   2. history: completed walks of the last 14 days that started within ±90 min of this time of day;
//      yes when at least 60% of them had it (needs 3 such walks)
//   3. the dog's usual routine: always a pee; a poop on the first morning walk, the late-morning walk
//      and the walk after dinner
// mod(ms) → minutes since local midnight (the Worker passes the home time zone's, the frame its own).
export const EXPECT_DAYS = 14, EXPECT_WINDOW = 90, EXPECT_SHARE = 0.6, EXPECT_MIN = 3;
const POOP_TIMES = [[5 * 60, 8 * 60 + 30], [10 * 60, 12 * 60 + 30], [19 * 60, 23 * 60 + 30]];

const near = (a, b, w) => { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d) <= w; };

export function routineExpect(m) {
  return { pee: true, poop: POOP_TIMES.some((r) => m >= r[0] && m <= r[1]), from: 'usual' };
}

export function historyExpect(walks, at, mod, skipId) {
  const m = mod(at), from = at - EXPECT_DAYS * 864e5;
  const slot = (walks || []).filter((w) => w && w.id !== skipId && w.endedAt != null && w.startedAt >= from && w.startedAt < at &&
    w.pee != null && near(mod(w.startedAt), m, EXPECT_WINDOW));
  if (slot.length < EXPECT_MIN) return null;
  const share = (k) => slot.filter((w) => w[k]).length / slot.length;
  return { pee: share('pee') >= EXPECT_SHARE, poop: share('poop') >= EXPECT_SHARE, from: 'history', n: slot.length };
}

// planned: the plan's expect (or null); walks: {id, startedAt, endedAt, pee, poop}, any order.
export function expectPotty(planned, walks, at, mod, skipId) {
  if (planned && typeof planned.pee === 'boolean' && typeof planned.poop === 'boolean') return { pee: planned.pee, poop: planned.poop, from: 'plan' };
  return historyExpect(walks, at, mod, skipId) || routineExpect(mod(at));
}

// The agent's expect from a plan PUT: {pee, poop} (booleans, "yes"/"no", 1/0) or null when absent or unclear.
export function normalizeExpect(v) {
  if (!v || typeof v !== 'object') return null;
  const b = (x) => (typeof x === 'boolean' ? x : x === 1 || x === 0 ? !!x : /^(y|yes|true)$/i.test(String(x)) ? true : /^(n|no|false)$/i.test(String(x)) ? false : null);
  const pee = b(v.pee), poop = b(v.poop);
  return pee == null || poop == null ? null : { pee, poop };
}

// The planned walk (planJSON item: {id, start ISO, walkerIds, expect}) a walk {startedAt, endedAt?, planId?}
// is for: the one it names, else the nearest within 90 min of its start, never one planned after it ended.
// A planId that is no longer in the plans (replanned) falls back to the nearest, as on the Worker (matchPlan).
export function planFor(rec, plans, now = Date.now()) {
  let best = null;
  const end = rec.endedAt || now;
  const all = (plans || []).flatMap((p) => (p && p.walks) || []);
  if (rec.planId) { const named = all.find((x) => x.id === rec.planId); if (named) return named; }
  for (const x of all) {
    const s = Date.parse(x.start), d = Math.abs(s - rec.startedAt);
    if (d <= EXPECT_WINDOW * 60e3 && s <= end && (!best || d < best.d)) best = { x, d };
  }
  return best ? best.x : null;
}

// The end-of-walk sheet's defaults → {plan, walkerIds, pee, poop, from}. Walkers: picked on the tile
// (rec.picked), else the planned walk's (known people only), else whoever started it, else [].
// isPerson(id) filters ids to the household.
export function suggestWalk(rec, plans, recent, mod, isPerson = () => true, now = Date.now()) {
  const x = planFor(rec, plans, now);
  const mine = (rec.walkers || []).map((w) => w.id).filter(isPerson);
  const planned = x ? (x.walkerIds || []).filter(isPerson) : [];
  const walkerIds = rec.picked && mine.length ? mine : planned.length ? planned : mine;
  const e = expectPotty(x && x.expect, recent, rec.startedAt, mod, rec.id);
  return { plan: x, walkerIds, pee: !!e.pee, poop: !!e.poop, from: e.from };
}
