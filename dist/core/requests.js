export const noopNotify = async () => { };
/**
 * Deliberately permissive: one `@`, no whitespace, a dot in the domain. Address
 * syntax is famously baroque, and the real validation is that approval mail has
 * to arrive — rejecting exotic-but-legal addresses here would only lock out
 * real people.
 */
export function isEmailish(email) {
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}
/**
 * Fields a stranger may fill in, clamped before they reach an admin's screen.
 *
 * Everything here is attacker-controlled text that gets rendered in a table
 * someone with `admin` is looking at, so it is length-capped and stripped of
 * control characters. `avatar` is *not* accepted from the form at all — a
 * URL supplied by an unauthenticated submitter and then rendered as `<img src>`
 * is a tracking pixel aimed at the admin page at best, so avatars are derived
 * client-side (`<Avatar>`) rather than collected. An app that genuinely wants
 * uploaded avatars can set `subject.avatar` itself after approval.
 */
export const MAX_SUBJECT_FIELD = 80;
export function cleanSubject(input) {
    const clean = (v) => {
        // Trim again after the cap: slicing mid-word can leave a trailing space.
        const t = v?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_SUBJECT_FIELD).trim();
        return t || undefined;
    };
    const subject = {};
    const name = clean(input.name);
    if (name)
        subject.name = name;
    return Object.keys(subject).length ? subject : null;
}
/** "Bob Smith" from a subject, or null if it holds no name. */
export function subjectName(subject) {
    return subject?.name || null;
}
export const DEFAULT_RATE_LIMIT = { perEmail: 3, perIp: 10, windowS: 3600 };
