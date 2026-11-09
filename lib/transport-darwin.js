/**
 * macOS notification transport.
 *
 * A stock macOS install has no `notify-send` and no user-installable toast API,
 * so this transport shells out to two binaries that are always present:
 *
 *  - `osascript` raises the banner with `display notification`.
 *  - `afplay` plays a system sound cue from `/System/Library/Sounds`.
 *
 * Two constraints shape the code:
 *
 *  - **No string interpolation into AppleScript.** The title and body travel as
 *    `argv` items to the script's `run` handler. Text with quotes, backslashes,
 *    newlines or CJK therefore needs no escaping at all -- the shell is not
 *    involved either, since `spawn` receives an argument vector.
 *  - **Banners have no click action.** `osascript` notifications cannot run a
 *    command when clicked, so `extra.launch` is ignored here; click-to-focus
 *    stays a Windows-only feature.
 *
 * @module dsh-notify/transport-darwin
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Directory holding the stock macOS alert sounds. */
export const SOUND_DIR = '/System/Library/Sounds';

/** Fallback cue when the configured `soundEvent` has no macOS equivalent. */
export const DEFAULT_SOUND = 'Glass';

/**
 * Windows sound-scheme events → stock macOS sounds.
 *
 * The Windows names are the documented configuration surface; mapping them
 * keeps one profile patch valid on both platforms. `Notification.Default` is
 * the ~1s `Glass` chime, closest to the Windows default cue.
 */
export const SOUND_MAP = {
  'Notification.Default': 'Glass',
  'Notification.IM': 'Ping',
  'Notification.Mail': 'Pop',
  'Notification.Reminder': 'Morse',
  'Notification.SMS': 'Funk',
  'Notification.Proximity': 'Tink',
  'Notification.Looping.Alarm': 'Sosumi',
  'Notification.Looping.Alarm2': 'Basso',
  'Notification.Looping.Alarm3': 'Blow',
  'Notification.Looping.Alarm4': 'Bottle',
  'Notification.Looping.Alarm5': 'Frog',
  'Notification.Looping.Alarm6': 'Hero',
  'Notification.Looping.Alarm7': 'Purr',
  'Notification.Looping.Alarm8': 'Submarine',
  'Notification.Looping.Alarm9': 'Blow',
  'Notification.Looping.Alarm10': 'Basso',
};

/** Hard cap on cue repeats so a typo can never turn into an endless alarm. */
const MAX_REPEATS = 5;

/**
 * Report a helper process that started but failed.
 *
 * A permission-denied banner still exits `0`, so this only catches genuine
 * script errors -- but those are exactly the ones that would otherwise vanish
 * into `stdio: 'ignore'`.
 */
function logExit(child, label, log) {
  child.on('exit', (code, signal) => {
    if (code !== 0) log(`${label} exited with ${code === null ? signal : `code ${code}`}`);
  });
}

/**
 * Build the `osascript` argument vector for one banner.
 *
 * The script body is a constant; the texts are appended as `argv` items and
 * retrieved with `item 1 of argv` / `item 2 of argv`.
 *
 * @param {unknown} title - banner title.
 * @param {unknown} body - banner body.
 * @returns {string[]} argv for `spawn('osascript', ...)`.
 */
export function osascriptArgs(title, body) {
  return [
    '-e', 'on run argv',
    '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
    '-e', 'end run',
    String(title ?? ''),
    String(body ?? ''),
  ];
}

/**
 * Resolve which `.aiff` file to play.
 *
 * `darwinSound` accepts either an absolute path or a bare sound name
 * (`"Pop"`, `"Pop.aiff"`), which is handy for sounds the user dropped into
 * `~/Library/Sounds`. With no override, the Windows `soundEvent` is mapped.
 *
 * @param {object} opts - merged plugin configuration.
 * @returns {string} absolute path of the sound file.
 */
export function resolveSound(opts) {
  const explicit = String(opts?.darwinSound ?? '').trim();
  if (explicit.length > 0) {
    if (explicit.includes('/')) return explicit;
    return join(SOUND_DIR, explicit.endsWith('.aiff') ? explicit : `${explicit}.aiff`);
  }
  const mapped = SOUND_MAP[String(opts?.soundEvent ?? '')] ?? DEFAULT_SOUND;
  return join(SOUND_DIR, `${mapped}.aiff`);
}

/**
 * How many times to play the cue for one notification.
 *
 * A critical toast repeats `criticalRepeat` times (clamped to 1..5); a normal
 * one always plays once. macOS has no long-duration banner, so the repeated
 * cue is what makes a critical alert feel different.
 *
 * @param {object} opts - merged plugin configuration.
 * @param {{critical?: boolean}} extra - notification extras.
 * @returns {number} repeat count in 1..5.
 */
export function soundRepeats(opts, extra = {}) {
  if (extra.critical !== true) return 1;
  const requested = Math.trunc(Number(opts?.criticalRepeat));
  if (!Number.isFinite(requested)) return 1;
  return Math.min(MAX_REPEATS, Math.max(1, requested));
}

/**
 * Create the macOS transport.
 *
 * `spawnImpl` and `fileExists` are injectable so the offline tests can assert
 * the exact argv without raising a real banner or playing a sound.
 *
 * @param {object} deps - transport dependencies.
 * @param {object} deps.opts - merged plugin configuration.
 * @param {(message: string) => void} deps.log - host logger.
 * @param {typeof spawn} [deps.spawnImpl] - spawn override for tests.
 * @param {(path: string) => boolean} [deps.fileExists] - file probe override.
 * @returns {{platform: string, prepare: Function, notify: Function}} transport.
 */
export function createDarwinTransport({ opts, log, spawnImpl = spawn, fileExists = existsSync }) {
  const soundFile = resolveSound(opts);

  /** Play the cue `times` in a row, chaining on process exit. */
  const playSound = (times) => {
    let remaining = times;
    const playNext = () => {
      if (remaining <= 0 || !fileExists(soundFile)) return;
      remaining -= 1;
      let child;
      try {
        child = spawnImpl('afplay', [soundFile], { stdio: 'ignore' });
      } catch (error) {
        log(`afplay spawn error: ${String(error)}`);
        return;
      }
      child.on('error', (error) => log(`afplay spawn failed: ${error.message}`));
      logExit(child, 'afplay', log);
      if (remaining > 0) child.on('exit', playNext);
      child.unref();
    };
    playNext();
  };

  const notify = (title, body, extra = {}) => {
    try {
      const child = spawnImpl('osascript', osascriptArgs(title, body), { stdio: 'ignore' });
      // A missing osascript or a denied Automation permission must never throw
      // into the host: log and carry on.
      child.on('error', (error) => log(`osascript spawn failed: ${error.message}`));
      logExit(child, 'osascript', log);
      child.unref();
    } catch (error) {
      log(`osascript spawn error: ${String(error)}`);
    }

    if (opts.sound === false) return;
    if (!fileExists(soundFile)) {
      log(`sound file not found: ${soundFile}`);
      return;
    }
    playSound(soundRepeats(opts, extra));
  };

  return {
    platform: 'darwin',
    /** No registration step: osascript needs no bundle id or URL protocol. */
    prepare() {},
    notify,
  };
}
