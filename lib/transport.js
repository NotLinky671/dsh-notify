/**
 * Platform transport selection for dsh-notify.
 *
 * The decision core (`core.js`) is platform-neutral: it only calls
 * `notify(title, body, extra)`. Everything OS-specific lives behind this
 * boundary, which is why adding macOS support did not touch the event policy.
 *
 * @module dsh-notify/transport
 */

import { createDarwinTransport } from './transport-darwin.js';
import { createWin32Transport } from './transport-win32.js';

/** Platforms with a working delivery layer. */
export const SUPPORTED_PLATFORMS = ['win32', 'darwin'];

/**
 * Build the transport for one platform.
 *
 * @param {string} platform - value of `process.platform`.
 * @param {object} deps - forwarded to the platform factory.
 * @param {string} deps.root - absolute plugin root (Windows scripts live there).
 * @param {object} deps.opts - merged plugin configuration.
 * @param {(message: string) => void} deps.log - host logger.
 * @param {Function} [deps.spawnImpl] - spawn override used by the macOS tests.
 * @param {(path: string) => boolean} [deps.fileExists] - file probe override.
 * @returns {{platform: string, prepare: Function, notify: Function} | null} transport, or null when unsupported.
 */
export function createTransport(platform, deps) {
  if (platform === 'win32') return createWin32Transport(deps);
  if (platform === 'darwin') return createDarwinTransport(deps);
  return null;
}
