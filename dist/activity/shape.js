export function activityText(value, field, max = 512) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
        throw new TypeError(`activity: invalid ${field}`);
    }
}
export function activityInteger(value, field, min = 0) {
    if (!Number.isSafeInteger(value) || value < min)
        throw new TypeError(`activity: invalid ${field}`);
}
export function checkActivityKind(kind, policy) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(kind))
        throw new TypeError('activity: invalid kind');
    const modes = ['off', 'count', 'line'];
    const record = modes.indexOf(policy.record);
    const notify = modes.indexOf(policy.notify);
    if (record < 0 || notify < 0 || notify > record)
        throw new TypeError('activity: notify exceeds recording policy');
}
export function checkActivityKinds(kinds) {
    for (const [kind, policy] of Object.entries(kinds))
        checkActivityKind(kind, policy);
}
/** URL parsing rather than string concatenation prevents token-bearing queries reaching storage or sinks. */
export function activityPath(value) {
    const url = new URL(value, 'https://activity.invalid');
    if (!['http:', 'https:'].includes(url.protocol))
        throw new TypeError('activity: invalid path');
    return url.pathname.slice(0, 1024);
}
export function checkActivityEvent(e) {
    activityText(e.id, 'event id');
    activityText(e.actor.id, 'actor id');
    activityText(e.actor.name, 'actor name', 200);
    activityText(e.actor.via, 'actor via', 64);
    activityInteger(e.ts, 'timestamp');
    const url = new URL(e.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== e.origin)
        throw new TypeError('activity: invalid origin');
    if (e.line !== undefined && (typeof e.line !== 'string' || e.line.length > 2000))
        throw new TypeError('activity: invalid line');
    if (e.path !== undefined && typeof e.path !== 'string')
        throw new TypeError('activity: invalid path');
    if (e.sessionId !== undefined)
        activityText(e.sessionId, 'session id', 128);
}
export function checkActivityWrite(e) {
    checkActivityEvent(e);
    checkActivityKind(e.kind, e.policy);
    if (e.policy.record === 'off')
        throw new TypeError('activity: cannot append an off kind');
}
