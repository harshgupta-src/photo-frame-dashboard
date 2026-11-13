import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact, parseLines, redact } from '../src/copilotlog.js';
import { copilotRoute } from '../src/copilot.js';

const ev = (type, data, timestamp = '2026-11-12T15:00:00.000Z') => ({ type, data, timestamp });

test('compact keeps the main conversation, answers to forms and clipped tool results', () => {
  const { summary, transcript } = compact([
    ev('session.start', { selectedModel: 'claude-opus-5.5', context: { cwd: '/Users/h' }, startTime: '2026-11-12T14:59:00.000Z' }),
    ev('user.message', { content: '', transformedContent: '<memories/>', source: 'memory' }),
    ev('user.message', { content: 'Add sessions to the frame. Then deploy.' }),
    ev('assistant.message', { content: 'On it.' }),
    ev('tool.execution_start', { toolCallId: 'a', toolName: 'bash', toolTitle: 'Run', arguments: { command: 'ls', description: 'List files' } }),
    ev('tool.execution_complete', { toolCallId: 'a', success: false, result: { content: 'x'.repeat(2000) } }),
    ev('assistant.message', { content: 'sub-agent chatter', parentToolCallId: 't' }),
    ev('tool.execution_start', { toolCallId: 'b', toolName: 'view', parentToolCallId: 't', arguments: { path: '/x' } }),
    ev('human_response.recorded', { response: { message: 'Which?', content: { choice: 'A' } } }),
    ev('session.usage_record', { usage: { inputTokens: 100, outputTokens: 20, copilotUsage: { totalNanoAiu: 2.5e9 } } }, '2026-11-12T16:10:00.000Z'),
    ev('session.usage_record', { usage: { inputTokens: 1, outputTokens: 1, copilotUsage: { totalNanoAiu: 1e9 } }, parentToolCallId: 't' }, '2026-11-12T16:20:00.000Z'),
  ], { id: 's1' });
  assert.deepEqual(transcript.items.map((i) => i.k), ['u', 'a', 't', 'u']);
  assert.equal(summary.title, 'Add sessions to the frame.');
  assert.equal(summary.prompts, 2);
  assert.equal(summary.tools, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.model, 'claude-opus-5.5');
  assert.equal(summary.startedAt, '2026-11-12T14:59:00.000Z');
  assert.equal(summary.credits, 3.5, 'sub-agent usage still counts');
  assert.deepEqual(summary.hours, { [Math.floor(Date.parse('2026-11-12T16:00:00Z') / 3600e3)]: 3.5 });
  const tool = transcript.items[2];
  assert.equal(tool.label, 'List files');
  assert.equal(tool.detail, 'ls');
  assert.equal(tool.ok, false);
  assert.ok(tool.out.length <= 400);
  assert.deepEqual([transcript.items[3].q, transcript.items[3].text], ['Which?', 'A']);
});

test('redact masks tokens and assigned secrets', () => {
  const s = redact('token=abcdef123456 Authorization: Bearer abcdefghijklmnopqrstu ghp_' + 'a'.repeat(36) + ' keep me');
  assert.ok(!/abcdef123456|abcdefghijklmnopqrstu|ghp_a/.test(s));
  assert.ok(s.endsWith('keep me'));
});

test('parseLines only parses the kept event types', () => {
  const raw = ['{"type":"model.response","data":{"x":"{\\"type\\":\\"user.message\\"}"}}', '{"type":"user.message","data":{"content":"hi"}}', '{"type":"user.mess'].join('\n');
  assert.deepEqual(parseLines(raw).map((e) => e.type), ['user.message']);
});

function kv() {
  const m = new Map();
  return { m, get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); } };
}
const call = (env, path, init = {}, access = { read: true, push: true }) =>
  copilotRoute(new Request('https://w' + path, init), new URL('https://w' + path), env, access);
const post = (env, body, access) => call(env, '/copilot/push', { method: 'POST', body: JSON.stringify(body) }, access);

test('push stores each source separately; HA sessions are automations, cloud ones have no transcript', async () => {
  const env = { DATA: kv() };
  assert.equal((await post(env, { source: 'mac', sessions: [] }, { read: true, push: false })).status, 401);
  const usage = { copilot_plan: 'enterprise', quota_reset_date_utc: '2026-12-01T00:00:00.000Z', quota_snapshots: { premium_interactions: { timestamp_utc: '2026-11-12T22:00:00Z', credits_used: 8783, entitlement: 1e7, percent_remaining: 99.9 } } };
  let r = await post(env, {
    source: 'mac', usage,
    sessions: [{ id: 'm1', origin: 'mac', title: 'Dev', updatedAt: '2026-11-12T10:00:00Z' }, { id: 'c1', origin: 'cloud', title: 'Elsewhere', updatedAt: '2026-11-12T09:00:00Z' }],
    transcripts: { m1: { items: [{ k: 'u', text: 'hi' }] }, c1: { items: [] }, zz: { items: [] } },
  });
  assert.deepEqual(r.body, { ok: true, sessions: 2, transcripts: 1, skipped: ['c1', 'zz'] });
  await post(env, { source: 'ha', sessions: [{ id: 'h1', origin: 'ha', title: 'Walk plan', updatedAt: '2026-11-12T11:00:00Z' }], transcripts: { h1: { items: [] } }, usage: { ...usage, quota_snapshots: { premium_interactions: { timestamp_utc: '2026-11-12T21:00:00Z', credits_used: 1 } } } });
  r = await call(env, '/copilot');
  assert.deepEqual(r.body.sessions.map((s) => [s.id, s.origin, s.kind, s.transcript]), [
    ['h1', 'ha', 'automation', true], ['m1', 'mac', 'development', true], ['c1', 'cloud', 'development', false],
  ]);
  assert.equal(r.body.usage.used, 8783, 'an older snapshot does not replace a newer one');
  assert.equal((await call(env, '/copilot/session?id=m1')).body.items[0].text, 'hi');
  assert.equal((await call(env, '/copilot/session?id=c1')).status, 404);
  assert.equal((await call(env, '/copilot', {}, { read: false, push: true })).status, 401);
});

test('a source cannot claim another origin', async () => {
  const env = { DATA: kv() };
  await post(env, { source: 'ha', sessions: [{ id: 'x', origin: 'mac' }, { id: 'y', origin: 'cloud' }] });
  const { sessions } = (await call(env, '/copilot')).body;
  assert.deepEqual(sessions.map((s) => [s.origin, s.kind]), [['ha', 'automation'], ['ha', 'automation']]);
});
