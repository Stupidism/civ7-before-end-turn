// Uses the locally installed game's actual PanelAction code with a mocked native
// bridge. This tests wiring; it is NOT an in-game save/load test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { SaveGate, installTurnHook } from '../ui/save-gate.js';

const gameRoot = process.env.CIV7_GAME_DIR || "D:/Program Files (x86)/Steam/steamapps/common/Sid Meier's Civilization VII";
const panelPath = join(gameRoot, 'Base/modules/base-standard/ui/action/panel-action.js');
const restRoot = join(process.env.LOCALAPPDATA || '', "Firaxis Games/Sid Meier's Civilization VII/Mods/civ7-rest-guard");
const skip = !existsSync(panelPath);
const withoutImports = text => text.replace(/^import .*;\r?$/gm, '');
const modSource = withoutImports(readFileSync(new URL('../ui/before-end-turn.js', import.meta.url), 'utf8'));

function harness() {
  const calls = [], listeners = new Map(), timers = new Map(), domListeners = new Map();
  let timerId = 0, sent = false, now = 0;
  const config = { gameSeed: 31337, isAnyMultiplayer: false };
  const player = { isHuman: true, isTurnActive: true };
  function node() {
    return { style: {}, classList: { contains: () => false, add() {}, remove() {} },
      setAttribute() {}, appendChild() {}, remove() {}, contains: () => false };
  }
  const context = vm.createContext({
    SaveGate, installTurnHook,
    console: { warn() {}, error(message) { calls.push(['error-log', message]); } },
    document: { body: node(), createElement: node, querySelector: () => null },
    window: {
      addEventListener: (name, fn) => { if (!domListeners.has(name)) domListeners.set(name, new Set()); domListeners.get(name).add(fn); },
      removeEventListener: (name, fn) => domListeners.get(name)?.delete(fn)
    },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++timerId, clearInterval() {},
    Date: class extends Date { static now() { return now; } },
    engine: {
      on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
      off: (name, fn) => listeners.get(name)?.delete(fn), call() {}
    },
    Panel: class {}, ImageCache: class {}, styles: '',
    Controls: { define() {}, decorate() {}, loadStyle() {} },
    Audio: { playSound() {}, getSoundTag: value => value },
    UI: { isInGame: () => true, Player: { deselectAllUnits: () => calls.push(['deselect']) }, sendAudioEvent() {} },
    WorldUI: { pushGaussianBlurFilter() {} },
    InterfaceMode: { isInInterfaceMode: () => false },
    InputActionStatuses: { FINISH: 2 },
    Configuration: { getGame: () => config },
    GameContext: { localPlayerID: 0, hasSentTurnComplete: () => sent,
      sendTurnComplete: () => { sent = true; calls.push(['turn']); } },
    Game: { age: 0, turn: 4, AgeProgressManager: { isAgeOver: false } },
    Players: { isValid: () => true, get: () => player }, Autoplay: { isActive: false },
    GameStateStorage: { getGameConfigurationSaveType: () => 2 },
    SaveLocations: { LOCAL_STORAGE: 1 },
    SaveLocationCategories: { NORMAL: 64, AUTOSAVE: 8, QUICKSAVE: 16 },
    SaveFileTypes: { GAME_STATE: 1 },
    SerializerResult: { RESULT_OK: 0, RESULT_PENDING: 1 },
    ContextManager: { canSaveGame: () => true, handleInput: () => 'input', handleNavigation: () => 'nav' },
    DialogBoxManager: { createDialog_MultiOption: params => { calls.push(['dialog', params]); return 99; }, closeDialogBox() {} },
    Network: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, Cursor: {}
  });
  function emit(name, result) { for (const fn of [...(listeners.get(name) || [])]) fn(result); }
  context.Network.saveGame = params => { calls.push(['save', params]); emit('StartSaveRequest'); return true; };
  const gameCode = withoutImports(readFileSync(panelPath, 'utf8')).replace('export { PanelAction };', 'globalThis.PanelAction = PanelAction;');
  vm.runInContext(gameCode, context, { filename: panelPath });
  vm.runInContext(`(function () { ${modSource}\n})();`, context);
  const panel = Object.create(context.PanelAction.prototype);
  panel.canUnreadyTurn = () => false;
  panel.canEndTurn = () => true;
  panel.setEndTurnWaiting = () => calls.push(['waiting']);
  return {
    context, panel, config, calls, emit,
    complete: () => emit('SaveComplete', { options: 64, result: 0 }),
    flush() { for (const [id, timer] of [...timers]) if (timer.ms === 0) { timers.delete(id); timer.fn(); } },
    nextTurn() { sent = false; context.Game.turn++; },
    advanceTime(ms) { now += ms; },
    evaluate: source => vm.runInContext(`(function () { ${source}\n})();`, context),
    dispose: () => context.__civ7BeforeEndTurnV1.destroy()
  };
}

for (const method of ['onActionButton', 'onNextActionHotkey', 'onActionNextAction', 'onEngineInput', 'sendEndTurn']) {
  test(`installed game ${method}: native turn submission happens after the save`, { skip }, () => {
    const h = harness();
    h.panel[method]({ detail: { status: 2, name: 'force-end-turn' }, preventDefault() {}, stopPropagation() {} });
    assert.equal(h.calls.filter(x => x[0] === 'save').length, 1);
    assert.equal(h.calls.some(x => x[0] === 'turn' || x[0] === 'waiting' || x[0] === 'deselect'), false);
    h.complete(); h.flush();
    assert.deepEqual(h.calls.map(x => x[0]), ['save', 'waiting', 'deselect', 'turn']);
    h.dispose();
  });
}

test('adapter uses the same normal local overwrite slot on consecutive turns', { skip }, () => {
  const h = harness();
  h.panel.onActionButton(); h.complete(); h.flush(); h.nextTurn();
  h.panel.onActionButton(); h.complete(); h.flush();
  const saves = h.calls.filter(x => x[0] === 'save').map(x => JSON.parse(JSON.stringify(x[1])));
  const expected = { Location: 1, LocationCategories: 64, Type: 2, ContentType: 1, FileName: 'BeforeEndTurn', Overwrite: true };
  assert.deepEqual(saves, [expected, expected]);
  h.dispose();
});

test('adapter blocks engine input while saving and restores it afterwards', { skip }, () => {
  const h = harness(); let prevented = 0;
  const event = { preventDefault: () => prevented++, stopImmediatePropagation() {} };
  h.panel.onActionButton();
  assert.equal(h.context.ContextManager.handleInput(event), false);
  assert.equal(h.context.ContextManager.handleNavigation(event), false);
  assert.equal(prevented, 2);
  h.complete(); h.flush();
  assert.equal(h.context.ContextManager.handleInput(event), 'input');
  h.dispose();
});

test('adapter rejects autosave completion and exposes a failed write without advancing', { skip }, () => {
  const h = harness(); h.panel.onActionButton();
  h.emit('SaveComplete', { options: 8, result: 0 }); h.flush();
  assert.equal(h.calls.some(x => x[0] === 'turn'), false);
  h.emit('SaveComplete', { options: 64, result: 42 }); h.flush();
  assert.equal(h.calls.some(x => x[0] === 'turn'), false);
  assert.equal(h.calls.filter(x => x[0] === 'dialog').length, 1);
  const dialog = h.calls.find(x => x[0] === 'dialog')[1];
  dialog.options[1].callback();
  h.panel.sendEndTurn(); // Automatic attempts stay suppressed.
  assert.equal(h.calls.filter(x => x[0] === 'save').length, 1);
  h.panel.onActionButton(); // Explicit retry is accepted.
  assert.equal(h.calls.filter(x => x[0] === 'save').length, 2);
  h.complete(); h.flush();
  assert.equal(h.calls.filter(x => x[0] === 'turn').length, 1);
  h.dispose();
});

test('multiplayer bypasses the mod without creating a save', { skip }, () => {
  const h = harness(); h.config.isAnyMultiplayer = true;
  h.panel.onActionButton();
  assert.equal(h.calls.some(x => x[0] === 'save'), false);
  assert.equal(h.calls.some(x => x[0] === 'turn'), true);
  h.dispose();
});

test('installed Rest Guard completes its rest before saving, with no second rest at native submit', {
  skip: skip || !existsSync(join(restRoot, 'ui/rest-guard.js'))
}, () => {
  const h = harness();
  const read = name => withoutImports(readFileSync(join(restRoot, 'ui', name), 'utf8')).replace(/^export /gm, '');
  const defaults = h.evaluate(`${read('defaults.js')}\nreturn DEFAULTS;`);
  h.context.DEFAULTS = defaults;
  Object.assign(h.context, h.evaluate(`${read('rest-model.js')}\nreturn { RestGate, normalizeConfig, scheduleAt, nextRestTurn, STAGE_LENGTH };`));
  const hasRuntime = existsSync(join(restRoot, 'ui/rest-runtime.js'));
  if (hasRuntime) {
    h.context.RestSession = h.evaluate(`${read('rest-session.js')}\nreturn RestSession;`);
    h.context.UIGameLoadingState = { GameStarted: 9 };
    h.context.UI.getGameLoadingState = () => 9;
    Object.assign(h.context, h.evaluate(`${read('rest-runtime.js')}\nreturn { session, checkpoint, installLoadingHooks };`));
    h.context.Game.turn = 5;
  }
  h.context.RestStore = h.evaluate(`${read('rest-store.js')}\nreturn RestStore;`);
  h.context.RestView = class {
    constructor(callbacks) { this.callbacks = callbacks; this.root = { style: {} }; }
    close() { this.mode = null; } showRest() { this.mode = 'rest'; }
    updateRest() {} updateLauncher() {} destroy() {} setVisible() {}
  };
  const getRest = h.evaluate(`${read('rest-guard.js')}\nreturn () => controller;`);
  h.panel.onActionButton(); // The installed Rest Guard's first scheduled break.
  assert.equal(getRest().view.mode, 'rest');
  assert.equal(h.calls.some(x => x[0] === 'save'), false);
  h.advanceTime(300001);
  getRest().view.callbacks.resume();
  assert.equal(h.calls.filter(x => x[0] === 'save').length, 1);
  assert.equal(h.calls.some(x => x[0] === 'turn'), false);
  h.complete(); h.flush();
  assert.equal(h.calls.filter(x => x[0] === 'turn').length, 1);
  assert.equal(getRest().view.mode, null);
  h.dispose();
});
