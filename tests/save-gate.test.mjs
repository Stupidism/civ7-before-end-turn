import test from 'node:test';
import assert from 'node:assert/strict';
import { SaveGate, installTurnHook } from '../ui/save-gate.js';

function harness() {
  let context = { token: 'game:0:antiquity:23', active: true, sent: false, canSave: true };
  const timers = new Map();
  const calls = [];
  let sequence = 0;
  let retry;
  const env = {
    context: () => context,
    dialogOpen: () => false,
    setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id),
    showBusy: value => calls.push(value ? 'lock' : 'unlock'),
    save: () => { calls.push('save'); gate.onSaveStart(); return true; },
    isPending: r => r?.result === 'pending',
    matches: r => r?.options === 'normal',
    succeeded: r => r?.result === 'ok',
    saved: () => calls.push('saved'),
    notice: () => calls.push('notice'),
    error: (_text, again) => { calls.push('error'); retry = again; }
  };
  const gate = new SaveGate(env);
  const submit = () => calls.push('turn');
  return {
    gate, calls, env, submit,
    request: (manual = true) => gate.request(submit, manual),
    complete: (result = 'ok', options = 'normal') => gate.onSaveComplete({ result, options }),
    flush(ms = 0) {
      for (const [id, task] of [...timers]) {
        if (task.ms !== ms) continue;
        timers.delete(id); task.fn();
      }
    },
    setContext: next => { context = next === null ? null : { ...context, ...next }; },
    retry: () => retry()
  };
}

test('waits for successful completion, then advances exactly once after dispatch', () => {
  const h = harness();
  h.request(); h.request(); h.request();
  assert.deepEqual(h.calls, ['lock', 'save']);
  h.complete('pending');
  assert.equal(h.gate.busy, true);
  h.complete(); h.complete();
  assert.equal(h.calls.includes('turn'), false);
  h.flush();
  assert.deepEqual(h.calls, ['lock', 'save', 'unlock', 'saved', 'turn']);
});

test('ignores an unrelated quicksave or autosave completion', () => {
  const h = harness(); h.request();
  h.complete('ok', 'quick'); h.complete('ok', 'auto'); h.flush();
  assert.equal(h.calls.includes('turn'), false);
  h.complete(); h.flush();
  assert.equal(h.calls.filter(x => x === 'turn').length, 1);
});

test('waits for an existing save before starting the requested snapshot', () => {
  const h = harness(); h.gate.onSaveStart(); h.request();
  assert.deepEqual(h.calls, ['lock']);
  h.complete('ok', 'quick');
  assert.deepEqual(h.calls, ['lock']);
  h.flush();
  assert.deepEqual(h.calls, ['lock', 'save']);
  h.complete(); h.flush();
  assert.equal(h.calls.at(-1), 'turn');
});

test('overlapping save requests fail closed instead of using the wrong completion', () => {
  const h = harness(); h.request(); h.gate.onSaveStart();
  h.complete(); h.complete(); h.flush();
  assert.ok(h.calls.includes('error'));
  assert.equal(h.calls.includes('turn'), false);
});

for (const failure of ['rejected', 'throws', 'disk-full', 'timeout']) {
  test(`${failure}: does not advance and blocks automatic retry loops`, () => {
    const h = harness();
    if (failure === 'rejected') h.env.save = () => false;
    if (failure === 'throws') h.env.save = () => { throw new Error('offline'); };
    h.request();
    if (failure === 'disk-full') h.complete('full');
    if (failure === 'timeout') h.flush(60000);
    assert.equal(h.gate.busy, false);
    assert.ok(h.calls.includes('error'));
    assert.equal(h.calls.includes('turn'), false);
    const before = h.calls.length;
    h.request(false); h.request(false);
    assert.equal(h.calls.length, before);
  });
}

test('late completion after timeout cannot release a new request', () => {
  const h = harness(); h.request(); h.flush(60000);
  h.retry();
  assert.equal(h.calls.filter(x => x === 'save').length, 1);
  h.complete(); h.flush();
  assert.equal(h.calls.filter(x => x === 'save').length, 2);
  assert.equal(h.calls.includes('turn'), false);
  h.complete(); h.flush();
  assert.equal(h.calls.filter(x => x === 'turn').length, 1);
});

test('a missing native completion recovers with a fresh confirmed write', () => {
  const h = harness(); h.request();
  // Captured in game: StartSaveRequest, file written, no SaveComplete delivered.
  h.flush(5000);
  assert.equal(h.calls.filter(x => x === 'save').length, 2);
  assert.equal(h.calls.includes('turn'), false);
  h.complete(); h.flush();
  assert.equal(h.gate.inFlight, 0);
  assert.equal(h.calls.filter(x => x === 'turn').length, 1);
});

test('recovery rejected by an active native write keeps waiting for its completion', () => {
  const h = harness(); h.request();
  h.env.save = () => { h.calls.push('save-busy'); return false; };
  h.flush(5000);
  assert.ok(h.calls.includes('save-busy'));
  assert.equal(h.calls.includes('error'), false);
  assert.equal(h.gate.inFlight, 1);
  h.complete(); h.flush();
  assert.equal(h.calls.filter(x => x === 'turn').length, 1);
});

test('late completion before recovery starts cannot confirm the fresh write', () => {
  const h = harness(); h.request();
  h.env.save = () => { h.calls.push('save'); return true; };
  h.flush(5000);
  h.complete(); h.flush();
  assert.equal(h.calls.includes('turn'), false);
  h.gate.onSaveStart(); h.complete(); h.flush();
  assert.equal(h.calls.filter(x => x === 'turn').length, 1);
});

test('retry also recovers a stale outstanding count left by an earlier timeout', () => {
  const h = harness(); h.request(); h.flush(60000); h.retry();
  h.flush(5000);
  assert.equal(h.calls.filter(x => x === 'save').length, 2);
  h.complete(); h.flush();
  assert.equal(h.calls.filter(x => x === 'turn').length, 1);
});

test('recovery is bounded and never advances without a successful completion', () => {
  const h = harness(); h.request(); h.flush(5000); h.flush(5000);
  assert.equal(h.calls.filter(x => x === 'save').length, 2);
  h.flush(60000);
  assert.equal(h.calls.includes('turn'), false);
  assert.equal(h.calls.filter(x => x === 'error').length, 1);
});

test('recovery preserves synchronous completion when the native request is rejected', () => {
  const h = harness(); h.request();
  h.env.save = () => { h.complete(); return false; };
  h.flush(5000); h.flush();
  assert.equal(h.calls.filter(x => x === 'turn').length, 1);
  assert.equal(h.calls.includes('error'), false);
});

test('recovery handles synchronous start and completion after native acceptance', () => {
  const h = harness(); h.request();
  h.env.save = () => { h.gate.onSaveStart(); h.complete(); return true; };
  h.flush(5000); h.flush();
  assert.equal(h.calls.filter(x => x === 'turn').length, 1);
  assert.equal(h.gate.inFlight, 0);
});

test('a context change cancels recovery before issuing another write', () => {
  const h = harness(); h.request(); h.setContext({ token: 'another-game' });
  h.flush(5000);
  assert.equal(h.calls.filter(x => x === 'save').length, 1);
  assert.equal(h.calls.includes('turn'), false);
  assert.equal(h.gate.busy, false);
});

test('unloading cancels the recovery timer', () => {
  const h = harness(); h.request(); h.gate.dispose(); h.flush(5000);
  assert.equal(h.calls.filter(x => x === 'save').length, 1);
  assert.equal(h.calls.includes('turn'), false);
});

test('a failed recovery write still cannot advance the turn', () => {
  const h = harness(); h.request(); h.flush(5000); h.complete('disk-full'); h.flush();
  assert.equal(h.calls.includes('turn'), false);
  assert.equal(h.calls.filter(x => x === 'error').length, 1);
});

test('explicit retry after a failed save writes again before submitting', () => {
  const h = harness(); h.request(); h.complete('full');
  h.retry(); h.complete(); h.flush();
  assert.equal(h.calls.filter(x => x === 'save').length, 2);
  assert.equal(h.calls.filter(x => x === 'turn').length, 1);
});

for (const change of [{ token: 'other-game' }, { token: 'new-age:0' }, { active: false }, { sent: true }, null]) {
  test(`context changed during write: ${JSON.stringify(change)}`, () => {
    const h = harness(); h.request(); h.setContext(change); h.complete(); h.flush();
    assert.equal(h.calls.includes('turn'), false);
    assert.equal(h.gate.busy, false);
  });
}

test('unsupported session passes through; non-active local turn does not submit', () => {
  const h = harness(); h.setContext(null); h.request();
  assert.deepEqual(h.calls, ['turn']);
  const inactive = harness(); inactive.setContext({ active: false }); inactive.request();
  assert.deepEqual(inactive.calls, []);
});

test('age transition with saving prohibited preserves previous snapshot and continues', () => {
  const h = harness(); h.setContext({ canSave: false }); h.request();
  assert.deepEqual(h.calls, ['notice', 'turn']);
});

test('every new end-turn attempt overwrites again, including reload of same turn', () => {
  const h = harness();
  h.request(); h.complete(); h.flush();
  h.request(); h.complete(); h.flush();
  assert.equal(h.calls.filter(x => x === 'save').length, 2);
});

test('unloading while saving cleans up and never submits a stale turn', () => {
  const h = harness(); h.request(); h.gate.dispose(); h.complete(); h.flush(); h.flush(60000);
  assert.equal(h.calls.includes('turn'), false);
  assert.equal(h.calls.includes('error'), false);
  assert.equal(h.calls.at(-1), 'unlock');
});

test('turn hook preserves receiver, args and distinguishes automatic from manual input', () => {
  const calls = [];
  class Panel {
    sendEndTurn(arg) { calls.push([this, arg]); }
    onActionButton() { this.sendEndTurn('mouse'); }
    onNextActionHotkey() { this.sendEndTurn('key'); }
    onActionNextAction() { this.sendEndTurn('controller'); }
    onEngineInput() { this.sendEndTurn('force'); }
  }
  const pending = [];
  const unhook = installTurnHook(Panel.prototype, { request: (submit, manual) => pending.push({ submit, manual }) });
  const panel = new Panel();
  panel.onActionButton(); panel.onNextActionHotkey(); panel.onActionNextAction(); panel.onEngineInput();
  panel.sendEndTurn('auto');
  assert.equal(calls.length, 0);
  assert.deepEqual(pending.map(x => x.manual), [true, true, true, true, false]);
  for (const request of pending) request.submit();
  assert.ok(calls.every(x => x[0] === panel));
  assert.deepEqual(calls.map(x => x[1]), ['mouse', 'key', 'controller', 'force', 'auto']);
  unhook(); panel.sendEndTurn('restored');
  assert.equal(calls.at(-1)[1], 'restored');
});

test('outer rest wrapper can postpone entry until after the rest finishes', () => {
  const h = harness();
  class Panel { sendEndTurn() { h.submit(); } }
  installTurnHook(Panel.prototype, h.gate);
  const inner = Panel.prototype.sendEndTurn;
  let resume;
  Panel.prototype.sendEndTurn = function (...args) { resume = () => inner.apply(this, args); };
  new Panel().sendEndTurn();
  assert.deepEqual(h.calls, []);
  resume();
  assert.deepEqual(h.calls, ['lock', 'save']);
  h.complete(); h.flush();
  assert.equal(h.calls.at(-1), 'turn');
});
