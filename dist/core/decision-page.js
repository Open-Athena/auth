import { EMAIL_LINK_ACTOR } from './decisions.js';
import { subjectName } from './requests.js';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const when = (ts) => (ts === null ? 'an unknown time' : new Date(ts * 1000).toUTCString());
/** Never prints a name we don't have. See `EMAIL_LINK_ACTOR`. */
const by = (actor) => actor === null || actor === EMAIL_LINK_ACTOR ? 'via email link' : `by ${esc(actor)}`;
const who = (r) => {
    const name = subjectName(r.subject) ?? r.name;
    return esc(name ? `${name} <${r.email}>` : r.email);
};
const VERB_LABEL = { approve: 'Approve', deny: 'Deny' };
export function renderDecisionPage(view, opts = {}) {
    const { appName = 'this site', action = '' } = opts;
    const page = (title, inner, status = 200) => new Response(shell(title, inner), {
        status,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
    switch (view.kind) {
        case 'invalid':
            // One page for forged, expired, malformed and unknown-request alike:
            // telling a prober which of those they achieved tells them how close
            // they got.
            return page('Link no longer valid', `<h1>This link is no longer valid</h1>
         <p>It may have expired, or the request may have been removed. Open ${esc(appName)} to review pending requests.</p>`, 404);
        case 'unauthorized':
            return page('Sign in to decide', `<h1>Sign in to decide</h1>
         <p>${esc(appName)} requires an administrator session before a request can be decided.</p>`, 401);
        case 'confirm': {
            const { verb, request, token } = view;
            // The whole reason this page exists: a GET must not decide anything,
            // because mail scanners issue GETs for every URL they find.
            return page(`${VERB_LABEL[verb]} access request`, `<h1>${VERB_LABEL[verb]} this request?</h1>
         <dl>
           <dt>Who</dt><dd>${who(request)}</dd>
           <dt>Asked</dt><dd>${esc(when(request.createdAt))}</dd>
           ${request.note ? `<dt>Note</dt><dd>${esc(request.note)}</dd>` : ''}
         </dl>
         <form method="post" action="${esc(action)}">
           <input type="hidden" name="t" value="${esc(token)}">
           <button type="submit" class="${verb}">${VERB_LABEL[verb]}</button>
         </form>
         <p class="fine">Nothing has happened yet — this page only appears because your mail provider may have opened the link before you did.</p>`);
        }
        case 'decided': {
            const { verb, request, reversed } = view;
            const done = verb === 'approve' ? 'Approved' : 'Denied';
            return page(done, `<h1>${done}</h1>
         <p>${who(request)} ${verb === 'approve'
                ? 'has been sent a sign-in link.'
                : 'was not granted access, and has not been told.'}</p>
         ${reversed ? `<p class="fine">This reversed the earlier decision.${verb === 'deny' ? ' The link already sent has been revoked, and any active session ends on its next request.' : ''}</p>` : ''}`);
        }
        case 'already': {
            const { request } = view;
            const done = request.status === 'approved' ? 'approved' : 'denied';
            return page('Already decided', `<h1>Already ${done}</h1>
         <p>This request was ${done} ${by(request.decidedBy)} at ${esc(when(request.decidedAt))}. Nothing changed just now.</p>`);
        }
    }
}
const shell = (title, inner) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --mute:#666; --line:#e3e3e3; --ok:#1a7f37; --no:#a40e26 }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --bg:#16181c; --mute:#9aa0a6; --line:#2c2f36; --ok:#2ea043; --no:#d4344e }
  }
  body { margin:0; padding:8vh 5vw; background:var(--bg); color:var(--fg);
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif }
  main { max-width:34rem; margin:0 auto }
  h1 { font-size:1.5rem; margin:0 0 1rem }
  dl { display:grid; grid-template-columns:auto 1fr; gap:.4rem 1.2rem; margin:1.5rem 0;
       padding:1rem 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line) }
  dt { color:var(--mute) } dd { margin:0 }
  button { font:inherit; font-weight:600; color:#fff; border:0; border-radius:6px; padding:.6rem 1.6rem; cursor:pointer }
  button.approve { background:var(--ok) } button.deny { background:var(--no) }
  .fine { color:var(--mute); font-size:.875rem; margin-top:2rem }
</style></head>
<body><main>${inner}</main></body></html>
`;
