/**
 * File-backed diagnostics for dsh-notify.
 *
 * The desktop host runs without an attached console, so a plugin that fails to
 * load — or loads but never sees an event — leaves no trace anywhere the user
 * can read. This module appends one line per interesting moment to
 * `$DSH_HOME/storages/dsh-notify/diag.log`, which makes "did it even start?"
 * answerable without a debugger.
 *
 * @module dsh-notify/diag
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** `$DSH_HOME`, defaulting to the standard `~/.dsh`. */
function dshHome() {
  const configured = process.env.DSH_HOME;
  return typeof configured === 'string' && configured.length > 0 ? configured : join(homedir(), '.dsh');
}

/** Absolute path of the diagnostic log. */
export function diagPath() {
  return join(dshHome(), 'storages', 'dsh-notify', 'diag.log');
}

/**
 * Append one diagnostic line. Never throws: diagnostics must not be able to
 * break the notification path they are meant to observe.
 *
 * @param {string} scope - short tag, e.g. `apply` or `event`.
 * @param {unknown} detail - anything JSON-serialisable.
 */
export function trace(scope, detail) {
  try {
    const file = diagPath();
    mkdirSync(dirname(file), { recursive: true });
    let rendered;
    if (typeof detail === 'string') {
      rendered = detail;
    } else {
      try {
        rendered = JSON.stringify(detail);
      } catch {
        rendered = String(detail);
      }
    }
    appendFileSync(file, `${new Date().toISOString()} [${scope}] ${rendered}\n`, 'utf8');
  } catch {
    // Diagnostics are best-effort only.
  }
}
