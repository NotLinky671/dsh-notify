/**
 * Offline tests for the dsh-notify decision core.
 *
 * Run with: node --test test/run.mjs
 *
 * Every case drives `createCore` with injected fakes, so no toast is shown and
 * nothing under ~/.dsh is touched.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { approvalPolicy, createCore, DEFAULTS, dayKey, sessionLabel, truncate, turnReasonText } from '../lib/core.js';
import { apply } from '../lib/index.js';
import { createTransport, SUPPORTED_PLATFORMS } from '../lib/transport.js';
import {
  createDarwinTransport,
  osascriptArgs,
  resolveSound,
  SOUND_DIR,
  soundRepeats,
} from '../lib/transport-darwin.js';
import { createWin32Transport } from '../lib/transport-win32.js';

/** Build a core with captured toasts and controllable projections/state. */
function harness(overrides = {}) {
  const toasts = [];
  const state = overrides.state ?? {};
  const projections = overrides.projections ?? (() => null);
  const clock = overrides.clock ?? (() => new Date(2026, 9, 31, 12, 0, 0));

  const core = createCore({
    opts: { ...DEFAULTS, ...overrides.opts },
    notify: (title, body, extra) => toasts.push({ title, body, ...extra }),
    readProjections: projections,
    loadState: () => state,
    saveState: (next) => Object.assign(state, next),
    now: clock,
  });

  return { core, toasts, state };
}

/** A root session with a title event. */
function session(title = '测试会话', origin) {
  return {
    header: { id: 'session-abcdef123456', origin },
    events: title ? [{ type: 'session/title', data: { title } }] : [],
  };
}

test('sessionLabel folds the newest title, else falls back to the id prefix', () => {
  assert.equal(sessionLabel(session('我的任务')), '我的任务');
  // The id fallback strips the `session-` prefix instead of slicing it.
  assert.equal(sessionLabel(session(null)), 'abcdef12');
  assert.equal(sessionLabel({ header: { id: 'deadbeefcafe' } }), 'deadbeef');
  assert.equal(sessionLabel(null), '(未命名)');
});

test('sessionLabel prefers the header title over the event log', () => {
  assert.equal(sessionLabel({ header: { id: 'session-x', title: '标题' } }), '标题');
  assert.equal(sessionLabel({ title: '  纯空白  ' }), '纯空白');
  assert.equal(sessionLabel({ header: { id: 'session-' } }), 'session-');
});

test('turnReasonText maps every known reason kind', () => {
  assert.equal(turnReasonText({ kind: 'completed' }), '完成');
  assert.equal(turnReasonText({ kind: 'error' }), '出错');
  assert.equal(turnReasonText({ kind: 'aborted' }), '已中止');
  assert.equal(turnReasonText({ kind: 'max-tokens' }), '达到 token 上限');
  assert.equal(turnReasonText({ kind: 'weird' }), 'weird');
  assert.equal(turnReasonText(undefined), '结束');
});

test('truncate keeps short text and ellipsizes long text', () => {
  assert.equal(truncate('abc'), 'abc');
  assert.equal(truncate('x'.repeat(200)).length, 121);
});

test('approvalPolicy folds the newest policy event', () => {
  const s = { events: [{ type: 'approval/policy', data: { policy: 'ask' } }, { type: 'approval/policy', data: { policy: 'never' } }] };
  assert.equal(approvalPolicy(s), 'never');
  assert.equal(approvalPolicy({ events: [] }), undefined);
});

test('completed turn emits a non-critical banner', () => {
  const { core, toasts } = harness();
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].title, /任务完成/);
  assert.equal(toasts[0].critical, undefined);
});

test('failed turn escalates to a critical toast', () => {
  const { core, toasts } = harness();
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(toasts[0].critical, true);
  assert.match(toasts[0].title, /任务失败/);
});

test('interrupted turn stays informational', () => {
  const { core, toasts } = harness();
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
  assert.match(toasts[0].title, /任务中断/);
  assert.equal(toasts[0].critical, undefined);
});

test('subagent turns are silent by default and can be opted in', () => {
  const off = harness();
  off.core.onSessionEvent(session('子任务', 'subagent'), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(off.toasts.length, 0);

  const on = harness({ opts: { notifySubagentEnd: true } });
  on.core.onSessionEvent(session('子任务', 'subagent'), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(on.toasts.length, 1);
  assert.match(on.toasts[0].title, /子任务完成/);
});

test('approval under the ask policy is critical', () => {
  const { core, toasts } = harness();
  core.onSessionEvent(session(), { type: 'approval/asked', data: { toolName: 'pwsh', reason: '写文件' } });
  assert.equal(toasts[0].critical, true);
  assert.match(toasts[0].body, /pwsh/);
});

test('approval under the never policy reports an auto-rejection instead', () => {
  const s = session();
  s.events.push({ type: 'approval/policy', data: { policy: 'never' } });
  const { core, toasts } = harness();
  core.onSessionEvent(s, { type: 'approval/asked', data: { toolName: 'pwsh', reason: '写文件' } });
  assert.match(toasts[0].title, /已自动拒绝/);
  assert.equal(toasts[0].critical, undefined);
});

test('context warning fires above the threshold and respects its cooldown', () => {
  const projections = () => ({ contextPressure: { projectedTokens: 850000, contextWindow: 1000000 } });
  const { core, toasts } = harness({ projections });

  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts.length, 2); // completion + context warning
  assert.match(toasts[1].title, /上下文告警/);
  assert.match(toasts[1].body, /85%/);

  // Second turn inside the cooldown window stays quiet.
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts.length, 3); // completion only
});

test('context warning stays silent below the threshold', () => {
  const projections = () => ({ contextPressure: { projectedTokens: 500000, contextWindow: 1000000 } });
  const { core, toasts } = harness({ projections });
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts.length, 1);
});

test('context warning tolerates a missing window or pressure', () => {
  const projections = () => ({ contextPressure: { projectedTokens: 900000 } });
  const { core, toasts } = harness({ projections });
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts.length, 1);
});

test('daily budget charges deltas and warns once per day', () => {
  let total = 1000;
  const projections = () => ({ tokenUsage: { uncachedInputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  const { core, toasts } = harness({ projections, opts: { dailyTokenBudget: 5000, notifyTurnEnd: false } });

  // First sight seeds the baseline without charging history.
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts.length, 0);

  total = 3000;
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts.length, 0); // 2000 of 5000

  total = 6500;
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts.length, 1); // 5500 > 5000
  assert.match(toasts[0].title, /预算/);
  assert.equal(toasts[0].critical, true);

  total = 9000;
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts.length, 1); // already warned today
});

test('a new local day resets the budget bucket', () => {
  let day = 31;
  const clock = () => new Date(2026, 9, day, 12, 0, 0);
  let total = 10;
  const projections = () => ({ tokenUsage: { uncachedInputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  const { core, toasts, state } = harness({ projections, clock, opts: { dailyTokenBudget: 100, notifyTurnEnd: false } });

  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } }); // baseline only
  assert.equal(toasts.length, 0);

  total = 500;
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts.length, 1);
  assert.equal(state.day, dayKey(new Date(2026, 9, 31, 12, 0, 0)));

  day = 1; // next month: the bucket resets and the same day's warning is forgotten
  total = 1100;
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts.length, 2);
});

test('quiet hours suppress every toast', () => {
  const clock = () => new Date(2026, 9, 31, 2, 0, 0);
  const { core, toasts } = harness({ clock, opts: { quietHours: [23, 8] } });
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(toasts.length, 0);
});

test('quiet hours wrapping past midnight covers both sides', () => {
  const late = harness({ clock: () => new Date(2026, 9, 31, 23, 30, 0), opts: { quietHours: [23, 8] } });
  late.core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(late.toasts.length, 0);

  const morning = harness({ clock: () => new Date(2026, 9, 31, 7, 30, 0), opts: { quietHours: [23, 8] } });
  morning.core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(morning.toasts.length, 0);

  const noon = harness({ clock: () => new Date(2026, 9, 31, 12, 0, 0), opts: { quietHours: [23, 8] } });
  noon.core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(noon.toasts.length, 1);
});

test('clickFocus adds the protocol launch target', () => {
  const { core, toasts } = harness();
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts[0].launch, 'dsh-notify:focus');

  const plain = harness({ opts: { clickFocus: false } });
  plain.core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(plain.toasts[0].launch, '');
});

test('a throwing projection read never breaks the toast path', () => {
  const projections = () => { throw new Error('boom'); };
  const { core, toasts } = harness({ projections });
  core.onSessionEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(toasts.length, 1);
});

test('unknown events are ignored', () => {
  const { core, toasts } = harness();
  core.onSessionEvent(session(), { type: 'session/title', data: { title: 'x' } });
  core.onSessionEvent(session(), { type: 42 });
  assert.equal(toasts.length, 0);
});

test('ask_user_question call raises a critical toast with the question header', () => {
  const { core, toasts } = harness();
  core.onSessionEvent(session(), {
    type: 'tool/call',
    data: {
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ id: 'q1', question: '选哪个？', header: '确认' }] }),
    },
  });
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].critical, true);
  assert.match(toasts[0].title, /需要你回答/);
  assert.equal(toasts[0].body, '确认');
});

test('ask_user_question falls back to the question text, then to a generic body', () => {
  const withQuestion = harness();
  withQuestion.core.onSessionEvent(session(), {
    type: 'tool/call',
    data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: '继续吗' }] }) },
  });
  assert.equal(withQuestion.toasts[0].body, '继续吗');

  const broken = harness();
  broken.core.onSessionEvent(session(), { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{not json' } });
  assert.equal(broken.toasts.length, 1);
  assert.match(broken.toasts[0].body, /等待你的回答/);
});

test('other tool calls never notify', () => {
  const { core, toasts } = harness();
  core.onSessionEvent(session(), { type: 'tool/call', data: { name: 'pwsh', arguments: '{}' } });
  assert.equal(toasts.length, 0);
});

test('a subagent cannot ask a human, so its ask call stays silent', () => {
  const { core, toasts } = harness();
  core.onSessionEvent(session('子任务', 'subagent'), {
    type: 'tool/call',
    data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'x' }] }) },
  });
  assert.equal(toasts.length, 0);
});

test('notifyQuestion: false disables the ask toast', () => {
  const { core, toasts } = harness({ opts: { notifyQuestion: false } });
  core.onSessionEvent(session(), {
    type: 'tool/call',
    data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'x' }] }) },
  });
  assert.equal(toasts.length, 0);
});

// ---------------------------------------------------------------------------
// Platform transport (Windows + macOS delivery layers)
// ---------------------------------------------------------------------------

/** A spawn stand-in that records argv and exposes its listeners. */
function recordingSpawn() {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const listeners = {};
    const child = {
      on(event, handler) {
        listeners[event] = handler;
        return child;
      },
      unref() {},
    };
    calls.push({ command, args, options, listeners });
    return child;
  };
  return { calls, spawnImpl };
}

test('transport selection covers Windows and macOS and rejects the rest', () => {
  const deps = { root: process.cwd(), opts: { ...DEFAULTS }, log: () => {} };
  assert.deepEqual(SUPPORTED_PLATFORMS, ['win32', 'darwin']);
  assert.equal(createTransport('win32', deps).platform, 'win32');
  assert.equal(createTransport('darwin', deps).platform, 'darwin');
  assert.equal(createTransport('linux', deps), null);
  assert.equal(createTransport('freebsd', deps), null);
});

test('Windows registers the protocol only when clickFocus is on', () => {
  const { calls, spawnImpl } = recordingSpawn();
  const root = process.cwd();

  createWin32Transport({ root, opts: { ...DEFAULTS, clickFocus: false }, log: () => {}, spawnImpl }).prepare();
  assert.equal(calls.length, 0);

  createWin32Transport({ root, opts: { ...DEFAULTS, clickFocus: true }, log: () => {}, spawnImpl }).prepare();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.deepEqual(calls[0].args.slice(-4), ['-Root', root, '-Aumid', DEFAULTS.aumid]);
  assert.ok(calls[0].args.includes(join(root, 'scripts', 'register.ps1')));
});

test('osascript receives title and body as argv, never as script source', () => {
  const title = '「会话」任务完成';
  const body = 'he said "hi" \\ and\nsecond line';
  const args = osascriptArgs(title, body);

  assert.deepEqual(args.slice(0, -2), [
    '-e', 'on run argv',
    '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
    '-e', 'end run',
  ]);
  // Verbatim, unescaped: the script body is constant and never interpolated.
  assert.equal(args.at(-2), title);
  assert.equal(args.at(-1), body);
  assert.ok(!args.slice(0, -2).some((part) => part.includes(title)));
});

test('macOS sound resolution maps Windows events and honours an override', () => {
  assert.equal(resolveSound({ soundEvent: 'Notification.Default' }), join(SOUND_DIR, 'Glass.aiff'));
  assert.equal(resolveSound({ soundEvent: 'Notification.Looping.Alarm' }), join(SOUND_DIR, 'Sosumi.aiff'));
  assert.equal(resolveSound({ soundEvent: 'Notification.NotAThing' }), join(SOUND_DIR, 'Glass.aiff'));
  assert.equal(resolveSound({}), join(SOUND_DIR, 'Glass.aiff'));
  assert.equal(resolveSound({ darwinSound: 'Pop' }), join(SOUND_DIR, 'Pop.aiff'));
  assert.equal(resolveSound({ darwinSound: 'Pop.aiff' }), join(SOUND_DIR, 'Pop.aiff'));
  assert.equal(resolveSound({ darwinSound: '/tmp/custom.aiff' }), '/tmp/custom.aiff');
});

test('macOS critical cue repeats are clamped to 1..5', () => {
  assert.equal(soundRepeats({}, {}), 1);
  assert.equal(soundRepeats({ criticalRepeat: 3 }, { critical: true }), 3);
  assert.equal(soundRepeats({ criticalRepeat: 99 }, { critical: true }), 5);
  assert.equal(soundRepeats({ criticalRepeat: 0 }, { critical: true }), 1);
  assert.equal(soundRepeats({ criticalRepeat: 'nope' }, { critical: true }), 1);
  assert.equal(soundRepeats({ criticalRepeat: 3 }, { critical: false }), 1);
});

test('the macOS transport raises a banner, then plays the cue', () => {
  const { calls, spawnImpl } = recordingSpawn();
  const transport = createDarwinTransport({
    opts: { ...DEFAULTS },
    log: () => {},
    spawnImpl,
    fileExists: () => true,
  });

  transport.notify('「会话」任务完成', '回复结束（完成）', {});
  assert.deepEqual(calls.map((call) => call.command), ['osascript', 'afplay']);
  assert.deepEqual(calls[0].args, osascriptArgs('「会话」任务完成', '回复结束（完成）'));
  assert.deepEqual(calls[0].options, { stdio: 'ignore' });
  assert.deepEqual(calls[1].args, [join(SOUND_DIR, 'Glass.aiff')]);
});

test('sound: false keeps the banner but skips afplay', () => {
  const { calls, spawnImpl } = recordingSpawn();
  const transport = createDarwinTransport({
    opts: { ...DEFAULTS, sound: false },
    log: () => {},
    spawnImpl,
    fileExists: () => true,
  });
  transport.notify('t', 'b', { critical: true });
  assert.deepEqual(calls.map((call) => call.command), ['osascript']);
});

test('a critical cue repeats by chaining afplay on exit', () => {
  const { calls, spawnImpl } = recordingSpawn();
  const transport = createDarwinTransport({
    opts: { ...DEFAULTS, criticalRepeat: 3 },
    log: () => {},
    spawnImpl,
    fileExists: () => true,
  });
  transport.notify('t', 'b', { critical: true });

  assert.equal(calls.filter((call) => call.command === 'afplay').length, 1);
  for (let i = 0; i < 5; i += 1) {
    const afplays = calls.filter((call) => call.command === 'afplay');
    afplays.at(-1).listeners.exit?.();
  }
  // Three total: 1 immediate + 2 chained.
  assert.equal(calls.filter((call) => call.command === 'afplay').length, 3);
});

test('a missing cue file skips afplay without skipping the banner', () => {
  const { calls, spawnImpl } = recordingSpawn();
  const transport = createDarwinTransport({
    opts: { ...DEFAULTS },
    log: () => {},
    spawnImpl,
    fileExists: () => false,
  });
  transport.notify('t', 'b', {});
  assert.deepEqual(calls.map((call) => call.command), ['osascript']);
});

test('a throwing spawn never escapes the macOS transport', () => {
  const transport = createDarwinTransport({
    opts: { ...DEFAULTS },
    log: () => {},
    spawnImpl: () => {
      throw new Error('boom');
    },
    fileExists: () => false,
  });
  assert.doesNotThrow(() => transport.notify('t', 'b', {}));
});

test('apply() wires both subscriptions on macOS', { skip: process.platform !== 'darwin' }, () => {
  const subscribed = [];
  const logs = [];
  const warns = [];
  const ctx = {
    logger: { info: (message) => logs.push(message), warn: (message) => warns.push(message) },
    on(event) {
      subscribed.push(event);
      return () => {};
    },
    effect: (fn) => fn,
  };

  apply(ctx, {});
  assert.deepEqual(subscribed, ['session/event', 'tools/result']);
  assert.ok(logs.some((line) => line.includes('enabled on darwin')));
  assert.ok(warns.some((line) => line.includes('clickFocus is Windows-only')));
});
