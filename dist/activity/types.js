export const DEFAULT_ACTIVITY_KINDS = {
    view: { record: 'line', notify: 'count' },
    nav: { record: 'line', notify: 'count' },
    click: { record: 'count', notify: 'count' },
    error: { record: 'line', notify: 'line' },
    access: { record: 'line', notify: 'line' },
    /** A tab picked up again after a gap: its earlier burst (and thread) continues, with this line. */
    resume: { record: 'line', notify: 'line' },
    /** A refused request: an expired, revoked or disabled link, a bad token (`accessLogActivity` maps `deny` rows here). */
    denied: { record: 'line', notify: 'line' },
};
export const BATCH_GAP_S = 15 * 60;
/** How far back a tab's session resumes its own earlier burst. */
export const RESUME_S = 7 * 86400;
export const ACTIVITY_LINES = 100;
export const ACTIVITY_SESSIONS = 50;
/** After the nth consecutive failure, a burst waits `min(2^(n-1) × 30s, 15 min)` before its next send to that sink. */
export const ACTIVITY_RETRY_S = 30;
export const ACTIVITY_RETRY_MAX_S = 15 * 60;
