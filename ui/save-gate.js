// Engine-independent coordinator. No turn is submitted until SaveComplete succeeds.
export class SaveGate {
  constructor(env) {
    this.env = env;
    this.job = null;
    this.inFlight = 0;
    this.failedToken = null;
    this.disposed = false;
    this.recoveryEvents = null;
  }

  get busy() { return this.job !== null; }

  request(submit, manual = false) {
    if (this.disposed || this.job || this.env.dialogOpen()) return;
    const context = this.env.context();
    if (!context) return submit(); // Multiplayer/observers: leave the base game alone.
    if (!context.active || context.sent) return;
    if (!context.canSave) {
      this.env.notice('当前阶段游戏不允许普通存档，保留最近的 BeforeEndTurn 存档。');
      return submit(); // E.g. the age has already ended; preserve the preceding turn.
    }
    if (this.failedToken === context.token && !manual) return;
    this.failedToken = null;
    const job = { context, submit, phase: 'waiting', timer: null, deferred: null,
      recoveryTimer: null, requireStart: false };
    this.job = job;
    this.env.showBusy(true);
    this.armTimeout(job);
    job.recoveryTimer = this.env.setTimer(() => this.recover(job), 5000);
    if (this.inFlight === 0) this.start(job);
  }

  isCurrent(job) {
    const current = this.env.context();
    return current?.token === job.context.token && current.active && !current.sent && current.canSave;
  }

  armTimeout(job) {
    this.env.clearTimer(job.timer);
    job.timer = this.env.setTimer(() => {
      if (this.job !== job) return;
      this.fail('等待存档完成超时（60 秒）。本回合尚未结束；可以重试存档，或留在本回合。');
    }, 60000);
  }

  start(job) {
    if (this.job !== job) return;
    if (!this.isCurrent(job)) return this.cancel();
    if (this.inFlight !== 0) return;
    job.phase = 'saving';
    this.armTimeout(job);
    try {
      // The shipped save screen treats the return value as acceptance, not completion.
      const accepted = this.env.save();
      if (!accepted && this.job === job) this.fail('游戏没有接受存档请求。请检查本地存储后重试。');
    } catch (error) {
      if (this.job === job) this.fail(`无法开始存档：${String(error)}`);
    }
  }

  recover(job) {
    job.recoveryTimer = null;
    if (this.job !== job || job.phase === 'saved') return;
    if (!this.isCurrent(job)) return this.cancel();
    if (this.inFlight === 0) return;
    // Native writes can finish without a delivered SaveComplete. The native
    // serializer rejects another request while busy; an accepted fresh write
    // lets us discard stale event counts, but is never itself proof of success.
    const events = this.recoveryEvents = [];
    let accepted = false;
    try { accepted = this.env.save(); }
    catch { /* Keep waiting for the original request, within the same timeout. */ }
    this.recoveryEvents = null;
    if (accepted && this.job === job) {
      this.inFlight = 0;
      job.phase = 'saving';
      job.requireStart = true;
      this.env.recovering?.(job.context);
    }
    // Preserve synchronous native callbacks too. On rejection they still belong
    // to the original write. On acceptance require the fresh StartSaveRequest.
    for (const [method, result] of events) this[method](result);
  }

  onSaveStart() {
    if (this.disposed) return;
    if (this.recoveryEvents) return void this.recoveryEvents.push(['onSaveStart']);
    this.inFlight++;
    if (this.job?.phase === 'saving') this.job.requireStart = false;
    // SaveComplete has no guaranteed per-request ID. Never guess when two writes overlap.
    if (this.job?.phase === 'saving' && this.inFlight > 1) {
      this.fail('检测到同时进行的其他存档。为确保备份正确，已取消本次过回合，请等存档结束后再试。');
    }
  }

  onSaveComplete(result) {
    if (this.recoveryEvents) return void this.recoveryEvents.push(['onSaveComplete', result]);
    if (this.disposed || this.env.isPending(result)) return;
    this.inFlight = Math.max(0, this.inFlight - 1);
    const job = this.job;
    if (!job) return; // Includes late completion after cancellation/timeout.
    if (job.phase === 'waiting') {
      if (this.inFlight === 0 && job.deferred === null) {
        // Let the previous save's other event handlers finish before requesting ours.
        job.deferred = this.env.setTimer(() => {
          job.deferred = null;
          this.start(job);
        }, 0);
      }
      return;
    }
    if (job.phase !== 'saving' || job.requireStart || !this.env.matches(result)) return;
    if (!this.env.succeeded(result)) {
      this.fail(`存档失败（错误码 ${String(result?.result)}）。本回合尚未结束。`);
      return;
    }
    job.phase = 'saved';
    // Never advance from inside the engine's SaveComplete dispatch stack.
    job.deferred = this.env.setTimer(() => {
      if (this.job !== job) return;
      if (!this.isCurrent(job)) return this.cancel();
      const submit = job.submit;
      this.cancel();
      this.env.saved(job.context);
      submit();
    }, 0);
  }

  fail(message) {
    const job = this.job;
    if (!job) return;
    this.failedToken = job.context.token;
    this.cancel();
    // Suppress automatic retries until an explicit user action (or another turn).
    this.env.error(message, () => {
      if (!this.disposed && this.isCurrent(job)) this.request(job.submit, true);
    });
  }

  cancel() {
    const job = this.job;
    this.job = null;
    if (!job) return;
    this.env.clearTimer(job.timer);
    this.env.clearTimer(job.deferred);
    this.env.clearTimer(job.recoveryTimer);
    this.env.showBusy(false);
  }

  dispose() {
    this.cancel();
    this.disposed = true;
  }
}

// Patch the JS class, not a native engine function and not the whole shipped file.
export function installTurnHook(prototype, gate) {
  const original = prototype.sendEndTurn;
  if (typeof original !== 'function') throw new Error('PanelAction.sendEndTurn is unavailable');
  let manualDepth = 0;
  const wrapped = function (...args) {
    return gate.request(() => original.apply(this, args), manualDepth > 0);
  };
  prototype.sendEndTurn = wrapped;
  const methods = ['onActionButton', 'onNextActionHotkey', 'onActionNextAction', 'onEngineInput'];
  const hooks = [];
  for (const name of methods) {
    const previous = prototype[name];
    if (typeof previous !== 'function') continue;
    const hook = function (...args) {
      manualDepth++;
      try { return previous.apply(this, args); }
      finally { manualDepth--; }
    };
    prototype[name] = hook;
    hooks.push({ name, previous, hook });
  }
  return () => {
    // Never overwrite a wrapper installed by another mod after ours.
    if (prototype.sendEndTurn === wrapped) prototype.sendEndTurn = original;
    for (const { name, previous, hook } of hooks) {
      if (prototype[name] === hook) prototype[name] = previous;
    }
  };
}
