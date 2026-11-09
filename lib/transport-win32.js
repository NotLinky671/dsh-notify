/**
 * Windows notification transport.
 *
 * Banners are raised through Windows PowerShell 5.1's WinRT projection, which
 * is present on every Windows 10/11 install -- no native modules, no
 * `node-notifier`, no build step. Click-to-focus needs two HKCU registrations
 * (an AppUserModelID and the `dsh-notify:` URL protocol) done once per load.
 *
 * @module dsh-notify/transport-win32
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Run one bundled PowerShell script detached, ignoring its output. */
function spawnPowerShell(root, scriptName, args, log, spawnImpl) {
  const script = join(root, 'scripts', scriptName);
  if (!existsSync(script)) {
    log(`missing script: ${script}`);
    return;
  }
  try {
    const child = spawnImpl(
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
 * Create the Windows transport.
 *
 * @param {object} deps - transport dependencies.
 * @param {string} deps.root - absolute plugin root, used to locate `scripts/`.
 * @param {object} deps.opts - merged plugin configuration.
 * @param {(message: string) => void} deps.log - host logger.
 * @param {typeof spawn} [deps.spawnImpl] - spawn override for tests.
 * @returns {{platform: string, prepare: Function, notify: Function}} transport.
 */
export function createWin32Transport({ root, opts, log, spawnImpl = spawn }) {
  /**
   * Show one toast.
   *
   * The payload travels through a UTF-8 JSON file rather than argv so that CJK
   * text survives the Windows PowerShell 5.1 command line intact.
   */
  const notify = (title, body, extra = {}) => {
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
    spawnPowerShell(root, 'toast.ps1', ['-Payload', file], log, spawnImpl);

    // Sound is played by us, not by the toast: `<audio>` in a toast XML is
    // silently ignored for unpackaged desktop apps.
    if (opts.sound !== false) {
      const repeat = payload.critical ? Math.max(1, Number(opts.criticalRepeat) || 1) : 1;
      spawnPowerShell(
        root,
        'sound.ps1',
        ['-Event', String(opts.soundEvent || 'Notification.Default'), '-Repeat', String(repeat)],
        log,
        spawnImpl,
      );
    }
  };

  /**
   * Register the `dsh-notify:` URL protocol and the AppUserModelID once per
   * process, so a toast click can focus the DSH window.
   */
  const prepare = () => {
    if (!opts.clickFocus) return;
    spawnPowerShell(root, 'register.ps1', ['-Root', root, '-Aumid', opts.aumid], log, spawnImpl);
  };

  return { platform: 'win32', prepare, notify };
}
