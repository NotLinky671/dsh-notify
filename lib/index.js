/**
 * dsh-notify — native desktop notifications for DeepSeek Harness events.
 *
 * Host plugin: subscribes to the session event firehose, decides whether an
 * event deserves the user's attention (see `core.js`), and hands the banner to
 * the platform transport:
 *
 *  - Windows: Windows PowerShell 5.1's WinRT toast projection.
 *  - macOS: `osascript` for the banner and `afplay` for the cue.
 *
 * No runtime dependencies and no build step on either platform.
 *
 * @module dsh-notify
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCore, DEFAULTS } from './core.js';
import { trace } from './diag.js';
import { createTransport } from './transport.js';

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

  const transport = createTransport(process.platform, { root: ROOT, opts, log });
  if (!transport) {
    warn(`platform ${process.platform} is unsupported; dsh-notify supports Windows and macOS`);
    trace('apply-skip', `unsupported platform ${process.platform}`);
    return;
  }

  if (transport.platform === 'darwin' && opts.clickFocus) {
    // The core still tags toasts with a launch target; macOS banners simply
    // cannot act on it. Say so once instead of failing silently.
    warn('clickFocus is Windows-only; macOS banners have no click action (notifications still work)');
  }

  transport.prepare();

  const notify = (title, body, extra = {}) => {
    log(`toast: ${title} — ${body}`);
    trace('toast', { title, body, critical: extra.critical === true });
    transport.notify(title, body, extra);
  };

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
    `enabled on ${transport.platform}: turnEnd=${opts.notifyTurnEnd} turnError=${opts.notifyTurnError} ` +
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
