/**
 * Pure decision core for dsh-notify.
 *
 * This module owns every "should we notify?" decision and the accounting that
 * feeds it. It performs no I/O: the cordis wiring in `index.js` injects the
 * side effects (toast dispatch, projection reads, state persistence), which
 * keeps the whole policy surface testable offline.
 *
 * @module dsh-notify/core
 */

/** Default configuration; every key is overridable from the profile patch layer. */
export const DEFAULTS = {
  /** Banner when a root turn completes normally. */
  notifyTurnEnd: true,
  /** Alert when a root turn fails, banner when it is interrupted/blocked. */
  notifyTurnError: true,
  /** Alert when a tool permission request needs a human decision. */
  notifyApproval: true,
  /** Alert when the agent calls `ask_user_question` and blocks for an answer. */
  notifyQuestion: true,
  /** Banner when a subagent turn ends (off: background subtasks are noisy). */
  notifySubagentEnd: false,
  /** Context-window occupancy percentage that triggers a warning; 0 disables. */
  contextWarnPercent: 80,
  /** Minimum gap between two context warnings in the same session, ms. */
  contextCooldownMs: 300000,
  /** Daily token budget; 0 disables the check. */
  dailyTokenBudget: 0,
  /** Play a notification sound. */
  sound: true,
  /**
   * Windows sound-scheme event used for the cue; macOS maps it onto a stock
   * alert sound. `Notification.Default` is the short system chime (~1.3s);
   * `Notification.Looping.Alarm` is the 5.6s alarm.
   */
  soundEvent: 'Notification.Default',
  /** How many times a critical cue repeats (bounded: never an endless alarm). */
  criticalRepeat: 1,
  /**
   * macOS-only: override the cue with a sound name (`Pop`, `Pop.aiff`) or an
   * absolute path. Empty means "map `soundEvent` onto a stock sound".
   */
  darwinSound: '',
  /** Clicking a toast focuses the DSH window (Windows only: needs the URL protocol). */
  clickFocus: true,
  /** Windows-only AppUserModelID used for the toast; registered under HKCU on load. */
  aumid: 'DeepSeek.Harness.Notify',
  /** Optional [startHour, endHour) window, local time, during which no toast is shown. */
  quietHours: null,
  /** Append every event and dispatch to `storages/dsh-notify/diag.log`. */
  debug: false,
};

/** Four disjoint provider usage buckets reported by the token meter. */
const USAGE_KEYS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/** The model-facing tool whose call means "the agent is waiting for a human". */
const ASK_USER_TOOL = 'ask_user_question';

/**
 * Best-effort one-line summary of an `ask_user_question` call.
 *
 * The call's `arguments` field is the raw JSON string the model produced, so it
 * can be malformed; a broken payload must still produce a notification, just
 * with a generic body.
 *
 * @param {unknown} rawArguments - `tool/call` event's `arguments` string.
 * @returns {string | null} the first question's header/question, or null.
 */
function questionSummary(rawArguments) {
  if (typeof rawArguments !== 'string' || rawArguments.length === 0) return null;
  try {
    const parsed = JSON.parse(rawArguments);
    const list = parsed?.questions;
    if (!Array.isArray(list) || list.length === 0) return null;
    const first = list[0];
    const text = first?.header ?? first?.question;
    return typeof text === 'string' && text.trim() !== '' ? text.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a display label for a session.
 *
 * Tries the header/title fields first, then folds the newest `session/title`
 * event, and only then falls back to the id. The id fallback strips the
 * `session-` prefix, because slicing it verbatim yields a useless "session-".
 *
 * @param {object} session - live session object.
 * @returns {string} display label, never empty.
 */
export function sessionLabel(session) {
  for (const candidate of [session?.header?.title, session?.title]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }

  const events = session?.events;
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      const title = event?.data?.title;
      if (event?.type === 'session/title' && typeof title === 'string' && title.trim() !== '') {
        return title.trim();
      }
    }
  }

  const id = session?.header?.id ?? session?.id;
  if (typeof id === 'string' && id.length > 0) {
    const trimmed = id.replace(/^session-/, '');
    return trimmed.length > 0 ? trimmed.slice(0, 8) : id.slice(0, 8);
  }
  return '(未命名)';
}

/** Shorten a label for a toast title. */
function shortLabel(session, max = 18) {
  const label = sessionLabel(session);
  return label.length > max ? `${label.slice(0, max)}…` : label;
}

/** Human-readable `turn/end` reason. */
export function turnReasonText(reason) {
  switch (reason?.kind) {
    case 'completed': return '完成';
    case 'blocked': return '被阻塞';
    case 'max-tokens': return '达到 token 上限';
    case 'aborted': return '已中止';
    case 'error': return '出错';
    default: return typeof reason?.kind === 'string' ? reason.kind : '结束';
  }
}

/** Truncate free text for a toast body. */
export function truncate(value, max = 120) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Fold the newest `approval/policy`; `undefined` means the host default (`ask`). */
export function approvalPolicy(session) {
  const events = session?.events;
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]?.type === 'approval/policy') return events[i].data?.policy;
    }
  }
  return undefined;
}

/** Local `YYYY-MM-DD` key for daily accounting. */
export function dayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whether `date` falls inside the configured quiet window. */
function inQuietHours(quietHours, date) {
  if (!Array.isArray(quietHours) || quietHours.length !== 2) return false;
  const [start, end] = quietHours;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return false;
  const hour = date.getHours();
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end; // wraps past midnight
}

/** Total tokens across the four usage buckets. */
function usageTotal(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  let total = 0;
  for (const key of USAGE_KEYS) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

/**
 * Build the event-driven notification policy.
 *
 * @param {object} deps - injected side effects.
 * @param {object} deps.opts - merged configuration.
 * @param {(title: string, body: string, extra?: {critical?: boolean, launch?: string}) => void} deps.notify - dispatch one toast.
 * @param {(session: object) => object | null} [deps.readProjections] - current projection values for a session.
 * @param {() => object} [deps.loadState] - read persisted accounting state.
 * @param {(state: object) => void} [deps.saveState] - persist accounting state.
 * @param {() => Date} [deps.now] - clock injection for tests.
 * @returns {{onSessionEvent: Function, onToolsResult: Function}} handlers to wire onto the host context.
 */
export function createCore(deps) {
  const { opts, notify } = deps;
  const now = deps.now ?? (() => new Date());
  const readProjections = deps.readProjections ?? (() => null);
  const loadState = deps.loadState ?? (() => ({}));
  const saveState = deps.saveState ?? (() => {});

  const contextWarnedAt = new Map();
  const budgetWarnedDay = new Set();

  /** Read + normalize persisted accounting state. */
  const state = (() => {
    const loaded = loadState() ?? {};
    return {
      day: typeof loaded.day === 'string' ? loaded.day : '',
      dayTokens: typeof loaded.dayTokens === 'number' ? loaded.dayTokens : 0,
      seen: loaded.seen && typeof loaded.seen === 'object' ? { ...loaded.seen } : {},
    };
  })();

  const persist = () => {
    try {
      saveState(state);
    } catch {
      // Accounting must never break the notification path.
    }
  };

  /** Roll the daily bucket over at local midnight. */
  const rollDay = (date) => {
    const key = dayKey(date);
    if (state.day !== key) {
      state.day = key;
      state.dayTokens = 0;
      persist();
    }
    return key;
  };

  /** Emit one toast, honouring quiet hours. */
  const emit = (title, body, extra = {}) => {
    if (inQuietHours(opts.quietHours, now())) return;
    notify(title, body, extra);
  };

  /** Context-window occupancy warning for one session. */
  const checkContext = (session) => {
    const percent = Number(opts.contextWarnPercent);
    if (!Number.isFinite(percent) || percent <= 0) return;

    let values;
    try {
      values = readProjections(session) ?? {};
    } catch {
      return; // projection unavailable: stay silent rather than guess
    }
    const pressure = values.contextPressure;
    if (!pressure || typeof pressure !== 'object') return;

    const window = pressure.contextWindow;
    const used = typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens : pressure.pressureTokens;
    if (typeof window !== 'number' || window <= 0 || typeof used !== 'number' || used <= 0) return;

    const ratio = (used / window) * 100;
    if (ratio < percent) return;

    const sid = String(session?.header?.id ?? session?.id ?? '?');
    const at = now().getTime();
    const last = contextWarnedAt.get(sid);
    const cooldown = Number(opts.contextCooldownMs);
    if (Number.isFinite(cooldown) && cooldown > 0 && typeof last === 'number' && at - last < cooldown) return;
    contextWarnedAt.set(sid, at);

    emit(
      `「${shortLabel(session)}」上下文告警`,
      `已占用 ${ratio.toFixed(0)}%（${Math.round(used / 1000)}k / ${Math.round(window / 1000)}k）`,
      { critical: ratio >= 95, launch: opts.clickFocus ? 'dsh-notify:focus' : '' },
    );
  };

  /** Daily token budget check, fed by per-session cumulative usage deltas. */
  const checkBudget = (session) => {
    const budget = Number(opts.dailyTokenBudget);
    if (!Number.isFinite(budget) || budget <= 0) return;

    let values;
    try {
      values = readProjections(session) ?? {};
    } catch {
      return;
    }
    const total = usageTotal(values.tokenUsage);
    if (total <= 0) return;

    const sid = String(session?.header?.id ?? session?.id ?? '?');
    const seen = state.seen[sid];
    const date = now();
    const key = rollDay(date);

    if (typeof seen !== 'number') {
      // First observation of this session: record the baseline without
      // charging its whole history to today's budget.
      state.seen[sid] = total;
      persist();
      return;
    }
    if (total <= seen) {
      state.seen[sid] = total;
      return;
    }

    state.dayTokens += total - seen;
    state.seen[sid] = total;
    persist();

    if (state.dayTokens < budget || budgetWarnedDay.has(key)) return;
    budgetWarnedDay.add(key);
    emit(
      '「今日 token 预算」已用尽',
      `累计 ${Math.round(state.dayTokens / 1000)}k / 预算 ${Math.round(budget / 1000)}k`,
      { critical: true, launch: opts.clickFocus ? 'dsh-notify:focus' : '' },
    );
  };

  /** `session/event` handler: the event firehose for turn and approval events. */
  const onSessionEvent = (session, event) => {
    if (!event || typeof event.type !== 'string') return;
    const isSubagent = session?.header?.origin === 'subagent';
    const launch = opts.clickFocus ? 'dsh-notify:focus' : '';

    switch (event.type) {
      case 'turn/end': {
        const kind = event.data?.reason?.kind;
        const reason = turnReasonText(event.data?.reason);

        if (isSubagent) {
          if (opts.notifySubagentEnd) {
            emit(`「${shortLabel(session)}」子任务完成`, `子任务结束（${reason}）`, { launch });
          }
          return;
        }

        if (kind === 'completed') {
          if (opts.notifyTurnEnd) {
            emit(`「${shortLabel(session)}」任务完成`, `回复结束（${reason}）`, { launch });
          }
        } else if (opts.notifyTurnError) {
          if (kind === 'error') {
            emit(`「${shortLabel(session)}」任务失败`, `执行出错（${reason}）`, { critical: true, launch });
          } else {
            emit(`「${shortLabel(session)}」任务中断`, reason, { launch });
          }
        }

        // Usage checks ride the same boundary: the projection is final for the turn.
        checkContext(session);
        checkBudget(session);
        return;
      }

      // The agent is blocked waiting for a human answer. There is no dedicated
      // session event for it, so the ask tool's own call is the signal.
      case 'tool/call': {
        if (!opts.notifyQuestion) return;
        if (event.data?.name !== ASK_USER_TOOL) return;
        if (isSubagent) return; // delegated callers cannot ask a human
        emit(
          `「${shortLabel(session)}」需要你回答`,
          truncate(questionSummary(event.data?.arguments) ?? '模型正在等待你的回答'),
          { critical: true, launch },
        );
        return;
      }

      case 'approval/asked': {
        if (!opts.notifyApproval) return;
        const toolName = event.data?.toolName ?? '(未知工具)';
        const reason = event.data?.reason ?? '（未提供原因）';
        const policy = approvalPolicy(session) ?? 'ask';
        if (policy === 'never') {          emit(
            `「${shortLabel(session)}」权限请求（已自动拒绝）`,
            `工具 ${toolName}：${truncate(reason)}（策略 never）`,
            { launch },
          );
        } else {
          emit(
            `「${shortLabel(session)}」需要人工确认`,
            `工具 ${toolName}：${truncate(reason)}`,
            { critical: true, launch },
          );
        }
        return;
      }

      default:
        return;
    }
  };

  /** `tools/result` handler: only used for the budget's turn boundaries today. */
  const onToolsResult = () => {};

  return { onSessionEvent, onToolsResult, state };
}
