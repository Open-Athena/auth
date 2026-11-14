export const DEFAULT_ACTIVITY_KINDS = {
    view: { record: 'line', notify: 'count' },
    nav: { record: 'line', notify: 'count' },
    click: { record: 'count', notify: 'count' },
    error: { record: 'line', notify: 'line' },
    access: { record: 'line', notify: 'line' },
};
export const BATCH_GAP_S = 15 * 60;
export const ACTIVITY_LINES = 100;
/** After the nth consecutive failure, a burst waits `min(2^(n-1) × 30s, 15 min)` before its next send to that sink. */
export const ACTIVITY_RETRY_S = 30;
export const ACTIVITY_RETRY_MAX_S = 15 * 60;
