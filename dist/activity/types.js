export const DEFAULT_ACTIVITY_KINDS = {
    view: { record: 'line', notify: 'count' },
    nav: { record: 'line', notify: 'count' },
    click: { record: 'count', notify: 'count' },
    error: { record: 'line', notify: 'line' },
    access: { record: 'line', notify: 'line' },
};
export const BATCH_GAP_S = 15 * 60;
export const ACTIVITY_LINES = 100;
