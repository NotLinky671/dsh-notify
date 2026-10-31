/**
 * dsh-notify — Windows toast notifications for DeepSeek Harness events.
 *
 * Host plugin: subscribes to the session event firehose, decides whether an
 * event deserves the user's attention (see `core.js`), and shows a native
 * Windows toast through Windows PowerShell 5.1's WinRT projection.
 *
 * No runtime dependencies: the toast transport is a spawned `powershell.exe`,
 * so this package installs without a build step and without native modules.
 *
 * @module dsh-notify
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCore, DEFAULTS } from './core.js';
import { trace } from './diag.js';

/** Cordis function-plugin name. */
export const name = 'dsh-notify';

/**
 * No required services: `sessionProjections` is read lazily per event, so a
 * headless assembly without the projection registry still gets event toasts.
 */
export const inject = [];

/** Absolute plugin root (`lib/` parent), used to locate the PowerShell scripts. */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** `$DSH_HOME`, defaulting to the standard `~/.dsh`. */
function dshHome() {
  const configured = process.env.DSH_HOME;
  return typeof configured === 'string' && configured.length > 0 ? configured : join(homedir(), '.dsh');
}

/** Durable accounting file (daily token totals + per-session baselines). */
function statePath() {
  return join(dshHome(), 'storages', 'dsh-notify', 'state.json');
}

/** Read the accounting state; a missing or corrupt file starts clean. */
function loadState() {
  try {
    const file = statePath();
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist the accounting state, creating its directory on first use. */
function saveState(state) {
  try {
    const file = statePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // Accounting is best-effort; never let it break a notification.
  }
}

/** Run one bundled PowerShell script detached, ignoring its output. */
function spawnPowerShell(scriptName, args, log) {
  const script = join(ROOT, 'scripts', scriptName);
  if (!existsSync(script)) {
    log(`missing script: ${script}`);
    return;
  }
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', script,
        ...args,
      ],
      // NOTE: `detached: true` is deliberately NOT set. On Windows libuv turns
      // it into DETACHED_PROCESS, after which powershell.exe never actually
      // runs (the child is created but produces no effect). The host process is
      // long-lived, so a plain fire-and-forget child is both correct and safe.
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('error', (error) => log(`${scriptName} spawn failed: ${error.message}`));
    child.unref();
  } catch (error) {
    log(`${scriptName} spawn error: ${String(error)}`);
  }
}

/**
 * Show one toast.
 *
 * The payload travels through a UTF-8 JSON file rather than argv so that CJK
 * text survives the Windows PowerShell 5.1 command line intact.
 */
function makeNotifier(opts, log) {
  return (title, body, extra = {}) => {
    const payload = {
      aumid: opts.aumid,
      title: String(title ?? ''),
      body: String(body ?? ''),
      sound: opts.sound !== false,
      critical: extra.critical === true,
      launch: typeof extra.launch === 'string' ? extra.launch : '',
    };
    const file = join(
      tmpdir(),
      `dsh-notify-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    try {
      writeFileSync(file, JSON.stringify(payload), 'utf8');
    } catch (error) {
      log(`payload write failed: ${String(error)}`);
      return;
    }
    log(`toast: ${payload.title} — ${payload.body}`);
    trace('toast', { title: payload.title, body: payload.body, critical: payload.critical });
    spawnPowerShell('toast.ps1', ['-Payload', file], log);

    // Sound is played by us, not by the toast: `<audio>` in a toast XML is
    // silently ignored for unpackaged desktop apps.
    if (opts.sound !== false) {
      const repeat = payload.critical ? Math.max(1, Number(opts.criticalRepeat) || 1) : 1;
      spawnPowerShell(
        'sound.ps1',
        ['-Event', String(opts.soundEvent || 'Notification.Default'), '-Repeat', String(repeat)],
        log,
      );
    }
  };
}

/**
 * Register the `dsh-notify:` URL protocol and the AppUserModelID once per
 * process, so a toast click can focus the DSH window.
 */
function ensureProtocol(opts, log) {
  spawnPowerShell('register.ps1', ['-Root', ROOT, '-Aumid', opts.aumid], log);
}

/**
 * Install the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} [config] - profile patch configuration.
 */
export function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...(config ?? {}) };
  const log = (message) => {
    try {
      if (ctx?.logger?.info) ctx.logger.info(`[dsh-notify] ${message}`);
      else console.log(`[dsh-notify] ${message}`);
    } catch {
      // Logging must never throw into the host.
    }
  };
  const warn = (message) => {
    try {
      if (ctx?.logger?.warn) ctx.logger.warn(`[dsh-notify] ${message}`);
      else console.warn(`[dsh-notify] ${message}`);
    } catch {
      // ignore
    }
  };

  trace('apply', {
    platform: process.platform,
    pid: process.pid,
    node: process.versions.node,
    debug: opts.debug === true,
  });

  if (process.platform !== 'win32') {
    warn(`platform ${process.platform} is unsupported; dsh-notify only shows Windows toasts`);
    trace('apply-skip', `unsupported platform ${process.platform}`);
    return;
  }

  const notify = makeNotifier(opts, log);

  /** Read the token-meter projections for a session, when the registry is present. */
  const readProjections = (session) => {
    try {
      const registry = ctx?.sessionProjections;
      if (!registry || typeof registry.snapshot !== 'function') return null;
      return registry.snapshot(session)?.values ?? null;
    } catch (error) {
      warn(`projection read failed: ${String(error)}`);
      return null;
    }
  };

  const core = createCore({
    opts,
    notify,
    readProjections,
    loadState,
    saveState,
    now: () => new Date(),
  });

  if (opts.clickFocus) ensureProtocol(opts, log);

  let disposeSession = () => {};
  let disposeTools = () => {};
  try {
    disposeSession = ctx.on('session/event', (session, event) => {
      if (opts.debug) {
        trace('event', {
          type: event?.type,
          sid: String(session?.header?.id ?? '?').slice(0, 12),
          origin: session?.header?.origin ?? 'root',
        });
      }
      try {
        core.onSessionEvent(session, event);
      } catch (error) {
        warn(`session handler error: ${String(error)}`);
        trace('handler-error', String(error?.stack ?? error));
      }
    });

    disposeTools = ctx.on('tools/result', (exec, result) => {
      try {
        core.onToolsResult(exec, result);
      } catch (error) {
        warn(`tools handler error: ${String(error)}`);
      }
    });
    trace('subscribed', { events: ['session/event', 'tools/result'] });
  } catch (error) {
    trace('subscribe-error', String(error?.stack ?? error));
    warn(`subscribe failed: ${String(error)}`);
  }

  log(
    `enabled: turnEnd=${opts.notifyTurnEnd} turnError=${opts.notifyTurnError} ` +
      `approval=${opts.notifyApproval} subagent=${opts.notifySubagentEnd} ` +
      `context=${opts.contextWarnPercent}% budget=${opts.dailyTokenBudget}`,
  );

  // Cordis effect: dispose both subscriptions when the plugin unloads.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposeSession?.();
      disposeTools?.();
    });
  }
}
