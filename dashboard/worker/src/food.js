// Maya's daily food: when to go up by 1/4 cup.
//
// The Worker works out the facts (age, projected adult weight, growth pace, the label's band for her
// age and adult size, appetite); HA's daily check (ha/maya-food.yaml) adds her vault notes and asks the
// Copilot Agent to decide; the Worker then checks the decision against the facts before storing it.
// The frame shows a stored bump on the Maya tab and HA tells both phones before breakfast that day.
//
// One change at a time: no bump while her food is mid-transition (two foods mixed), within SETTLE days
// after any other change to her plan (food, number of meals, daily cups) or SETTLE days before the next
// one. HA sends the plan per day from the calendars: [{date, meals, cups, mixed}].
//
// GET  /dog/food                       { advice, history }
// POST /dog/food/facts  { plan }       { facts, advice, history }
// PUT  /dog/food        { decision: 'bump'|'hold', date, fromCups, toCups, meal, healthy, reason, plan, ... }
// POST /dog/food/done   { by }         marks the bump as done (it then counts as a change)

const DAY = 864e5;
const KEY = 'dog-food';
export const STEP = 0.25;
export const SETTLE = 7;

// Purina Pro Plan Puppy Large Breed label, cups/day: rows are weight at maturity (lb), columns age.
export const BANDS = [
  { lb: [50, 75], cups: [[4 / 3, 13 / 3], [11 / 3, 5.25], [2.75, 13 / 3], [8 / 3, 4]] },
  { lb: [76, 100], cups: [[1.75, 13 / 3], [4, 17 / 3], [4, 4.75], [4, 4.5]] },
  { lb: [101, 130], cups: [[1.75, 5.75], [4, 7.25], [13 / 3, 6], [4.5, 5.5]] },
  { lb: [131, 155], cups: [[7 / 3, 19 / 3], [5.25, 8], [5.5, 20 / 3], [5.5, 6.25]] },
];
export const STAGES = [{ name: '1½–5 months', from: 0 }, { name: '6–11 months', from: 6 }, { name: '12–20 months', from: 12 }, { name: '21–24 months', from: 21 }];

// Share of adult weight by age in weeks, a typical large-breed (25–35 kg) growth curve.
const CURVE = [[8, 0.18], [12, 0.28], [16, 0.38], [20, 0.47], [24, 0.55], [28, 0.62], [32, 0.68], [36, 0.74], [40, 0.79],
  [44, 0.83], [48, 0.87], [52, 0.9], [60, 0.94], [70, 0.97], [80, 0.99], [90, 1]];
function share(weeks) {
  if (weeks <= CURVE[0][0]) return CURVE[0][1];
  for (let i = 1; i < CURVE.length; i++) {
    const [w1, s1] = CURVE[i - 1], [w2, s2] = CURVE[i];
    if (weeks <= w2) return s1 + (s2 - s1) * (weeks - w1) / (w2 - w1);
  }
  return 1;
}

const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
function addMonths(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
function bandFor(lb) {
  return BANDS.reduce((best, b) => {
    const dist = lb < b.lb[0] ? b.lb[0] - lb : lb > b.lb[1] ? lb - b.lb[1] : 0;
    return dist < best.dist ? { b, dist } : best;
  }, { b: BANDS[0], dist: Infinity }).b;
}
function stageAt(birthday, iso) {
  let i = 0;
  STAGES.forEach((s, j) => { if (s.from && addMonths(birthday, s.from) <= iso) i = j; });
  return i;
}

// Cups as the label writes them: 3.75 → "3 3/4".
export function cupsText(c) {
  if (c == null) return '?';
  const whole = Math.floor(c + 1e-6), f = c - whole;
  const frac = [[0, ''], [1 / 4, '1/4'], [1 / 3, '1/3'], [1 / 2, '1/2'], [2 / 3, '2/3'], [3 / 4, '3/4'], [1, '']]
    .reduce((a, x) => (Math.abs(x[0] - f) < Math.abs(a[0] - f) ? x : a));
  const w = frac[0] === 1 ? whole + 1 : whole;
  return frac[1] ? (w ? w + ' ' : '') + frac[1] : String(w);
}

// The days where her plan changes from the day before: what changed.
export function planChanges(plan) {
  const days = (Array.isArray(plan) ? plan : []).filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.meals > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = [];
  for (let i = 1; i < days.length; i++) {
    const a = days[i - 1], b = days[i], what = [];
    if (!!a.mixed !== !!b.mixed) what.push(b.mixed ? 'food transition starts' : 'food transition ends');
    if (a.meals !== b.meals) what.push(a.meals + ' → ' + b.meals + ' meals');
    if (a.cups != null && b.cups != null && Math.abs(a.cups - b.cups) > 0.01) what.push(cupsText(a.cups) + ' → ' + cupsText(b.cups) + ' cups');
    if (what.length) out.push({ date: b.date, what: what.join(', ') });
  }
  return { days, changes: out };
}

// weights: [{at, kg, estimate}], meals: [{at, ate}] (Lifelog), plan: [{date, meals, cups, mixed}].
export function foodFacts({ birthday, weights = [], meals = [], plan = [], cups = null, now = Date.now(), history = [] }) {
  if (!birthday || !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) throw Object.assign(new Error('no birthday (DOG_BIRTHDAY)'), { status: 500 });
  const born = Date.parse(birthday + 'T12:00:00Z'), today = dayOf(now);
  const weeksAt = (t) => (t - born) / (7 * DAY);
  const ageWeeks = weeksAt(now);
  const w = weights.filter((x) => x && x.kg != null).map((x) => ({ ...x, t: Date.parse(x.at) })).sort((a, b) => a.t - b.t);
  const real = w.filter((x) => !x.estimate);
  const latest = w[w.length - 1] || null;

  // Adult weight: the median of what each recent real weigh-in (6 weeks, 12+ weeks old) projects.
  let basis = real.filter((x) => x.t >= now - 42 * DAY && weeksAt(x.t) >= 12);
  if (!basis.length) basis = (real.length ? real : w).slice(-3);
  const proj = basis.map((x) => x.kg / share(weeksAt(x.t))).sort((a, b) => a - b);
  const adultKg = proj.length ? r1(proj[Math.floor(proj.length / 2)]) : null;

  // Growth pace: least-squares slope over the real weigh-ins of the last 5 weeks vs the curve's.
  const recent = real.filter((x) => x.t >= now - 35 * DAY);
  let gain = null;
  if (recent.length >= 2 && recent[recent.length - 1].t - recent[0].t >= 7 * DAY) {
    const mt = recent.reduce((s, x) => s + x.t, 0) / recent.length, mk = recent.reduce((s, x) => s + x.kg, 0) / recent.length;
    const num = recent.reduce((s, x) => s + (x.t - mt) * (x.kg - mk), 0), den = recent.reduce((s, x) => s + (x.t - mt) ** 2, 0);
    gain = r2(num / den * 7 * DAY);
  }
  const expected = adultKg ? r2(adultKg * (share(ageWeeks + 1) - share(ageWeeks))) : null;
  const pace = gain == null || !expected ? 'unknown' : gain < expected * 0.6 ? 'slow' : gain > expected * 1.5 ? 'fast' : 'on track';

  const adultLb = adultKg ? Math.round(adultKg / 0.45359237) : null;
  const band = bandFor(adultLb || 60), si = stageAt(birthday, today);
  const stage = { name: STAGES[si].name, low: r2(band.cups[si][0]), high: r2(band.cups[si][1]) };
  const next = STAGES[si + 1] ? { date: addMonths(birthday, STAGES[si + 1].from), name: STAGES[si + 1].name,
    low: r2(band.cups[si + 1][0]), high: r2(band.cups[si + 1][1]) } : null;

  const week = meals.filter((m) => Date.parse(m.at) >= now - 7 * DAY);
  const left = week.filter((m) => m.ate && !/^all$/i.test(String(m.ate)));
  const lastDone = history.filter((h) => h.decision === 'bump' && h.doneAt).map((h) => h.date).sort().pop() || null;
  const pc = planChanges(plan), todayPlan = pc.days.find((d) => d.date === today) || null;
  const changes = pc.changes.concat(lastDone ? [{ date: lastDone, what: '1/4 cup bump' }] : []).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (cups == null && todayPlan) cups = todayPlan.cups;

  return {
    today, birthday,
    age: { weeks: r1(ageWeeks), months: r1((now - born) / (30.4375 * DAY)) },
    latest: latest && { date: dayOf(latest.t), kg: latest.kg, estimate: !!latest.estimate, where: latest.where || null },
    weighIns: w.map((x) => ({ date: dayOf(x.t), kg: x.kg, estimate: !!x.estimate, ...(x.low != null ? { low: x.low, high: x.high } : {}), where: x.where || null })),
    adult: adultKg && { kg: adultKg, lb: adultLb, from: basis.length + ' weigh-in' + (basis.length > 1 ? 's' : '') },
    growth: { kgPerWeek: gain, expectedKgPerWeek: expected, pace },
    band: { matureLb: band.lb.join('–'), ...stage },
    nextStage: next,
    cups,
    appetite: { meals7d: week.length, notAllEaten: left.map((m) => ({ at: m.at, meal: m.meal || null, ate: m.ate })) },
    lastBump: lastDone,
    today_plan: todayPlan,
    transition: pc.days.filter((d) => d.mixed && d.date >= today).map((d) => d.date),
    lastChange: changes.filter((c) => c.date <= today).pop() || null,
    nextChange: changes.find((c) => c.date > today) || null,
    changes,
    plannedDays: pc.days.length ? [pc.days[0].date, pc.days[pc.days.length - 1].date] : null,
  };
}

// The decision is only stored if it is safe: a bump is exactly +1/4 cup, from today's total, within
// the label's band on that date, for a puppy the agent judged healthy, ≥ 7 days after the last bump.
export function checkAdvice(a, facts) {
  if (!a || typeof a !== 'object') return 'no decision';
  if (a.decision === 'hold') return null;
  if (a.decision !== 'bump') return "decision must be 'bump' or 'hold'";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date || '')) return 'date must be YYYY-MM-DD';
  const ahead = (Date.parse(a.date) - Date.parse(facts.today)) / DAY;
  if (ahead < 0 || ahead > 14) return 'date must be within the next 14 days';
  if (a.healthy !== true) return 'only bump when she is healthy';
  if (typeof a.fromCups !== 'number' || typeof a.toCups !== 'number') return 'fromCups and toCups are needed';
  if (facts.cups != null && Math.abs(a.fromCups - facts.cups) > 0.01) return `fromCups must be today's ${facts.cups}`;
  if (a.decision === 'bump' && !a.date) return 'date is needed';
  if (Math.abs(a.toCups - a.fromCups - STEP) > 0.01) return 'a bump is exactly +1/4 cup';
  const band = facts.nextStage && facts.nextStage.date <= a.date ? facts.nextStage : facts.band;
  if (a.toCups > band.high + 0.01) return `${a.toCups} cups is above the label's ${band.high} for ${band.name}`;
  if (!facts.plannedDays) return "no meal plan, so one-change-at-a-time can't be checked";
  if (a.date > facts.plannedDays[1]) return 'the meal plan only runs to ' + facts.plannedDays[1];
  if (facts.transition.includes(a.date)) return 'her food is mid-transition on ' + a.date + '; one change at a time';
  const near = facts.changes.find((c) => Math.abs(Date.parse(c.date) - Date.parse(a.date)) / DAY < SETTLE);
  if (near) return `${near.what} on ${near.date} is within ${SETTLE} days; one change at a time`;
  return null;
}

async function load(env) {
  return (await env.DATA.get(KEY, 'json')) || { advice: null, history: [] };
}

function clean(a, now) {
  const s = (v, n) => (v == null ? null : String(v).slice(0, n));
  return {
    id: 'food-' + now, decision: a.decision, date: a.decision === 'bump' ? a.date : null,
    fromCups: a.fromCups ?? null, toCups: a.decision === 'bump' ? a.toCups : null, meal: s(a.meal, 40),
    healthy: a.healthy === true, reason: s(a.reason, 400), projection: s(a.projection, 300), nextCheck: s(a.nextCheck, 300),
    source: s(a.source, 40), checkedAt: new Date(now).toISOString(), doneAt: null, doneBy: null,
  };
}

// → { status, body }. `facts(plan, history)` builds the facts (dogapi.js supplies Lifelog's weights and meals).
export async function foodRoute(req, url, env, access, facts, now = Date.now()) {
  const m = req.method, p = url.pathname;
  if (!access.read) return { status: 401, body: { error: 'unauthorized' } };
  const st = await load(env);
  if (p === '/dog/food' && m === 'GET') return { status: 200, body: { advice: st.advice, history: st.history.slice(-10) } };
  let b;
  try { b = JSON.parse((await req.text()) || '{}'); } catch { return { status: 400, body: { error: 'bad JSON' } }; }
  if (p === '/dog/food/facts' && m === 'POST') {
    return { status: 200, body: { facts: await facts(b.plan, st.history), advice: st.advice, history: st.history.slice(-10) } };
  }
  if (!access.write) return { status: 401, body: { error: 'unauthorized' } };
  if (p === '/dog/food' && m === 'PUT') {
    const f = await facts(b.plan, st.history);
    const err = checkAdvice(b, f);
    if (err) return { status: 422, body: { error: err } };
    const a = clean(b, now);
    // A bump already done stays in the history; an undone one is replaced by the newer decision.
    st.advice = a;
    st.history = st.history.filter((h) => h.doneAt).concat(a).slice(-50);
    await env.DATA.put(KEY, JSON.stringify(st));
    return { status: 200, body: { advice: a } };
  }
  if (p === '/dog/food/done' && m === 'POST') {
    const a = st.advice;
    if (!a || a.decision !== 'bump') return { status: 409, body: { error: 'no bump to mark done' } };
    if (!a.doneAt) {
      a.doneAt = new Date(now).toISOString();
      a.doneBy = b.by ? String(b.by).slice(0, 40) : null;
      st.history = st.history.map((h) => (h.id === a.id ? a : h));
      await env.DATA.put(KEY, JSON.stringify(st));
    }
    return { status: 200, body: { advice: a } };
  }
  return { status: 404, body: { error: 'not found' } };
}

export async function foodAdvice(env) {
  return (await load(env)).advice;
}
