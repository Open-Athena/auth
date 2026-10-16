/**
 * A `Notify` that sends mail. Wire it into `createGate({ notify })`.
 *
 * The `access-granted` message is the only place a token is ever rendered, and
 * it goes to the address the grant is bound to and nowhere else — not to the
 * admin who approved it, and not into a log line.
 */
export function emailNotify(opts) {
    const { send, from, adminTo, appName = 'this site', linkFor, adminUrl, decideUrlFor, deliverTo = () => true, onUndelivered = () => { }, onError = () => { }, } = opts;
    return async (event) => {
        if (event.kind === 'access-granted' && !deliverTo(event.request.email)) {
            onUndelivered(event);
            return;
        }
        const msg = compose(event);
        if (!msg)
            return;
        const res = await send({ from, ...msg }).catch(e => ({ ok: false, error: String(e) }));
        if (!res.ok)
            onError(res.error, event);
    };
    function compose(event) {
        switch (event.kind) {
            case 'access-granted': {
                const url = linkFor(event.token);
                return {
                    to: event.request.email,
                    // No token in the subject: subjects are logged, previewed on lock
                    // screens, and quoted in replies.
                    subject: `Your link to ${appName}`,
                    text: [
                        greeting(event.request.name),
                        ``,
                        `Here's your link to ${appName}:`,
                        ``,
                        url,
                        ``,
                        `It's tied to this email address, so there's no password to set.`,
                        `If you didn't ask for this, you can ignore it — the link is only useful to whoever opens it.`,
                    ].join('\n'),
                };
            }
            case 'access-requested': {
                if (!adminTo)
                    return null;
                const { email, name, note } = event.request;
                const who = name ? `${name} <${email}>` : email;
                const links = event.decision && decideUrlFor
                    ? { approve: decideUrlFor(event.decision.approve), deny: decideUrlFor(event.decision.deny) }
                    : null;
                return {
                    to: adminTo,
                    subject: `Access request from ${email}`,
                    // Replying reaches the person who asked, which is usually what an
                    // admin wants to do first.
                    replyTo: email,
                    text: [
                        `${who} asked for access to ${appName}.`,
                        ...(note ? [``, `They said: ${note}`] : []),
                        ...(links ? [``, `Approve: ${links.approve}`, `Deny:    ${links.deny}`] : []),
                        ...(adminUrl ? [``, `All requests: ${adminUrl}`] : []),
                    ].join('\n'),
                    ...(links ? { html: requestHtml(who, note, links, appName, adminUrl) } : {}),
                };
            }
            case 'access-denied':
                // Deliberately silent. A denial notice tells someone who may have been
                // probing that the address exists and that a human looked at it, and
                // there is nothing actionable in it for a legitimate requester.
                return null;
        }
    }
}
const greeting = (name) => (name ? `Hi ${name.split(' ')[0]},` : 'Hi,');
/**
 * Inline styles only, and a table for the buttons: mail clients strip `<style>`
 * blocks and Outlook ignores most of flexbox. Ugly, and the only thing that
 * renders the same in Gmail, Apple Mail and Outlook.
 */
function requestHtml(who, note, links, appName, adminUrl) {
    const btn = (href, label, bg) => `<a href="${esc(href)}" style="display:inline-block; padding:10px 22px; margin-right:10px; border-radius:6px; background:${bg}; color:#fff; font-weight:600; text-decoration:none">${label}</a>`;
    return [
        `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif; font-size:15px; line-height:1.5; color:#111">`,
        `<p><strong>${esc(who)}</strong> asked for access to ${esc(appName)}.</p>`,
        note ? `<blockquote style="margin:0 0 16px; padding:8px 14px; border-left:3px solid #ddd; color:#444">${esc(note)}</blockquote>` : '',
        `<p style="margin:24px 0">${btn(links.approve, 'Approve', '#1a7f37')}${btn(links.deny, 'Deny', '#a40e26')}</p>`,
        `<p style="font-size:13px; color:#666">You'll get a confirmation page before anything is decided.${adminUrl ? ` <a href="${esc(adminUrl)}" style="color:#666">All requests</a>.` : ''}</p>`,
        `</div>`,
    ].join('');
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
