let sink = null;
let state = 'idle';
const early = [];
const EARLY_MAX = 20;
/** Record an event (a no-op while off; held briefly while the boot decides). */
export function slog(k, f = {}) {
    if (sink) {
        sink(k, f);
        return;
    }
    if ((state === 'pending' || state === 'idle') && early.length < EARLY_MAX)
        early.push({ t: Date.now(), k, ...f });
}
/** Whether a config answer means "log this tab now". */
export const shouldLog = (cfg, now = Date.now()) => !!cfg?.enabled && typeof cfg.until === 'number' && cfg.until > now;
/**
 * Decide, then start or stand down. Never throws and never delays the app:
 * call it without awaiting, once, at startup. Resolves to whether it started.
 */
export async function bootSessionLog(o) {
    if (state !== 'idle')
        return state === 'on';
    state = 'pending';
    const endpoint = o.endpoint ?? '/api/session-log';
    const onError = (e) => {
        const ee = e;
        slog('error', { msg: String(ee.message || ee.error).slice(0, 300) });
    };
    const onReject = (e) => slog('reject', { msg: String(e.reason).slice(0, 300) });
    addEventListener('error', onError);
    addEventListener('unhandledrejection', onReject);
    let cfg = null;
    try {
        const r = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok)
            cfg = await r.json();
    }
    catch {
        // Off.
    }
    removeEventListener('error', onError);
    removeEventListener('unhandledrejection', onReject);
    const standDown = () => {
        state = 'off';
        early.length = 0;
        return false;
    };
    if (!shouldLog(cfg))
        return standDown();
    try {
        const m = await import('./logger.js');
        const appEvents = cfg.appEvents ?? {};
        const { log, logger } = m.start({
            until: cfg.until,
            early: early.splice(0),
            build: o.build,
            endpoint,
            appEvents,
            secretParams: o.secretParams,
        });
        sink = log;
        state = 'on';
        const prevStop = logger.onStop;
        logger.onStop = () => {
            prevStop?.();
            sink = null;
            state = 'off';
        };
        return true;
    }
    catch {
        return standDown();
    }
}
/** Forget the boot (tests): back to idle, nothing held. */
export function resetSessionLog() {
    sink = null;
    state = 'idle';
    early.length = 0;
}
