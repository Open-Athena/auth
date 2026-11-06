import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Avatar } from './Avatar.js';
import { AvatarField } from './AvatarField.js';
import { useGrants } from './useGrants.js';
const DEFAULT_CLASSES = {
    panel: 'oa-ui oa-ui-grants',
    form: 'oa-ui-form',
    check: 'oa-ui-check',
    input: 'oa-ui-input',
    muted: 'oa-ui-muted',
    error: 'oa-ui-error',
    button: 'oa-ui-btn',
    primary: 'oa-ui-btn oa-ui-btn-primary',
    danger: 'oa-ui-btn oa-ui-btn-danger',
    linkish: 'oa-ui-linkish',
    list: 'oa-ui-list',
    card: 'oa-ui-card',
    cardRevoked: 'oa-ui-card oa-ui-card-revoked',
    cardHead: 'oa-ui-card-head',
    row: 'oa-ui-row',
    tag: 'oa-ui-tag',
    tagDead: 'oa-ui-tag oa-ui-tag-dead',
    facts: 'oa-ui-facts',
    holder: 'oa-ui-muted',
    holderForm: 'oa-ui-form',
    token: 'oa-ui-token',
    copyRow: 'oa-ui-copyrow',
    avatarField: '',
};
const ago = (ts) => {
    if (ts === null)
        return 'never';
    const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (s < 60)
        return `${s}s ago`;
    if (s < 3600)
        return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)
        return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
};
/** The moment a link exists outside its recipient's browser: show it, offer a copy, and say it won't come back. */
export function GrantLink({ grant, token, buildLink, onDismiss, labels = {}, classNames }) {
    const cx = { ...DEFAULT_CLASSES, ...classNames };
    const [copy, setCopy] = useState('idle');
    const link = buildLink(grant, token);
    return (_jsxs("div", { className: cx.token, children: [_jsx("p", { className: cx.muted, children: labels.warning ?? "Copy this now: only its hash is stored, so you won't see it again." }), _jsxs("div", { className: cx.copyRow, children: [_jsx("input", { className: cx.input, readOnly: true, value: link, "aria-label": "Share link", onFocus: e => e.currentTarget.select() }), _jsx("button", { className: cx.button, type: "button", onClick: async () => {
                            const ok = await navigator.clipboard.writeText(link).then(() => true, () => false);
                            setCopy(ok ? 'copied' : 'failed');
                            if (ok)
                                setTimeout(() => setCopy('idle'), 1500);
                        }, children: copy === 'copied' ? (labels.copied ?? 'Copied') : (labels.copy ?? 'Copy') }), onDismiss && (_jsx("button", { className: cx.button, type: "button", onClick: onDismiss, children: labels.dismiss ?? 'Done' }))] }), copy === 'failed' && (_jsx("p", { className: cx.error, role: "alert", children: labels.copyFailed ?? "Couldn't reach the clipboard. Select the link and copy it by hand." }))] }));
}
const DAY_S = 86400;
const resolveMemo = (memo) => (typeof memo === 'function' ? memo() : (memo ?? ''));
export function GrantMintForm({ scopes, onMint, busy = false, error, defaultMemo, expiryDays = [0, 1, 7, 30], defaultExpiryDays = 30, maxRedeems = [0, 1, 3], allowlist = false, avatarEndpoint, labels = {}, classNames, }) {
    const cx = { ...DEFAULT_CLASSES, ...classNames };
    const [memo, setMemo] = useState(() => resolveMemo(defaultMemo));
    const [holder, setHolder] = useState('');
    const [email, setEmail] = useState('');
    const [allow, setAllow] = useState(true);
    const [avatar, setAvatar] = useState(null);
    const [chosen, setChosen] = useState(() => new Set(scopes.length === 1 ? [scopes[0].id] : []));
    const [days, setDays] = useState(defaultExpiryDays);
    const [max, setMax] = useState(0);
    const [noScope, setNoScope] = useState(false);
    async function submit(e) {
        e.preventDefault();
        // In the order offered, whatever order they were clicked in: a hub's link
        // shape depends on the first scope.
        const picked = scopes.filter(s => chosen.has(s.id)).map(s => s.id);
        if (!picked.length) {
            setNoScope(true);
            return;
        }
        setNoScope(false);
        const name = holder.trim();
        const address = email.trim();
        const input = {
            name: memo.trim() || null,
            ...(name ? { subjectName: name } : {}),
            email: address || null,
            ...(allowlist && address ? { allowlist: allow } : {}),
            ...(avatarEndpoint ? { avatar } : {}),
            scopes: picked,
            maxRedeems: max > 0 ? max : null,
            expiresInS: days > 0 ? days * DAY_S : null,
        };
        if (await onMint(input)) {
            setMemo(resolveMemo(defaultMemo));
            setHolder('');
            setEmail('');
            setAvatar(null);
        }
    }
    return (_jsxs("form", { className: cx.form, onSubmit: submit, children: [_jsxs("label", { children: [_jsx("span", { children: labels.memo ?? 'Memo' }), _jsx("input", { className: cx.input, name: "memo", value: memo, onChange: e => setMemo(e.target.value), autoComplete: "off" })] }), _jsxs("label", { children: [_jsx("span", { children: labels.holder ?? 'Holder' }), _jsx("input", { className: cx.input, name: "holder", value: holder, onChange: e => setHolder(e.target.value), autoComplete: "off" })] }), _jsxs("label", { children: [_jsx("span", { children: labels.email ?? 'Email' }), _jsx("input", { className: cx.input, name: "email", type: "email", value: email, onChange: e => setEmail(e.target.value), autoComplete: "off" })] }), allowlist && (_jsxs("label", { className: cx.check, children: [_jsx("input", { type: "checkbox", checked: allow, onChange: e => setAllow(e.target.checked) }), _jsx("span", { children: labels.allowlist ?? 'Also let this email sign in' })] })), avatarEndpoint && (_jsxs("div", { className: cx.avatarField, children: [_jsx("label", { htmlFor: "oa-grant-avatar", children: labels.avatar ?? 'Face' }), _jsx(AvatarField, { id: "oa-grant-avatar", endpoint: avatarEndpoint, value: avatar, onChange: setAvatar, email: email, name: holder.trim() || null, size: 36, ...(classNames?.avatar ? { classNames: classNames.avatar } : {}) })] })), _jsxs("fieldset", { children: [_jsx("legend", { children: labels.scopes ?? 'Opens' }), scopes.map(scope => (_jsxs("label", { className: cx.check, children: [_jsx("input", { type: "checkbox", checked: chosen.has(scope.id), onChange: e => {
                                    const next = new Set(chosen);
                                    if (e.target.checked)
                                        next.add(scope.id);
                                    else
                                        next.delete(scope.id);
                                    setChosen(next);
                                    setNoScope(false);
                                } }), _jsxs("span", { children: [scope.label, scope.hint !== undefined && _jsxs("span", { className: cx.muted, children: [" ", scope.hint] })] })] }, scope.id)))] }), _jsxs("label", { children: [_jsx("span", { children: labels.expires ?? 'Expires in' }), _jsx("select", { className: cx.input, value: days, onChange: e => setDays(Number(e.target.value)), children: expiryDays.map(d => (_jsx("option", { value: d, children: d === 0 ? (labels.never ?? 'never') : d === 1 ? '1 day' : `${d} days` }, d))) })] }), _jsxs("label", { children: [_jsx("span", { children: labels.maxRedeems ?? 'Max redemptions' }), _jsx("select", { className: cx.input, value: max, onChange: e => setMax(Number(e.target.value)), children: maxRedeems.map(n => (_jsx("option", { value: n, children: n === 0 ? (labels.unlimited ?? 'unlimited') : n }, n))) })] }), _jsx("button", { className: cx.primary, type: "submit", disabled: busy, children: busy ? (labels.submitting ?? 'Minting…') : (labels.submit ?? 'Mint link') }), noScope && (_jsx("p", { className: cx.error, role: "alert", children: labels.scopeRequired ?? 'Choose at least one.' })), error && (_jsx("p", { className: cx.error, role: "alert", children: error }))] }));
}
/** Rotate and revoke can't be taken back, so each takes a second, deliberate click. */
function ConfirmButton({ className, disabled, label, confirm, onConfirm, }) {
    const [armed, setArmed] = useState(false);
    return (_jsx("button", { className: className, type: "button", disabled: disabled, onBlur: () => setArmed(false), onClick: () => {
            if (armed)
                onConfirm();
            setArmed(!armed);
        }, children: armed ? confirm : label }));
}
/** The offered scopes, then any on the link no longer offered. The last one checked can't be unchecked. */
function ScopeChecks({ grant, grants, scopes, busy, className }) {
    const listed = [...scopes.map(s => s.id), ...grant.scopes.filter(id => !scopes.some(s => s.id === id))];
    return (_jsx(_Fragment, { children: listed.map(id => {
            const on = grant.scopes.includes(id);
            return (_jsxs("label", { className: className, children: [_jsx("input", { type: "checkbox", checked: on, disabled: busy || (on && grant.scopes.length === 1), onChange: () => void grants.update(grant.id, { scopes: listed.filter(s => (s === id ? !on : grant.scopes.includes(s))) }) }), _jsx("span", { children: scopes.find(s => s.id === id)?.label ?? id })] }, id));
        }) }));
}
/** One link: its status, scopes, holder, activity, and the verbs that change it. */
export function GrantCard({ grant, grants, scopes = [], editScopes = false, buildLink, allowlist = false, avatarEndpoint, onHolderSaved, labels = {}, classNames }) {
    const cx = { ...DEFAULT_CLASSES, ...classNames };
    const [editing, setEditing] = useState(false);
    const { activity: loadActivity } = grants;
    const activity = grants.activities[grant.id];
    // Re-read when use of the link is seen, rather than once per link per poll.
    useEffect(() => {
        void loadActivity(grant.id);
    }, [loadActivity, grant.id, grant.lastUsedAt, grant.redeems]);
    const busy = grants.pending[grant.id] !== undefined;
    const revoked = grant.revokedAt !== null;
    const disabled = grant.disabledAt !== null;
    const expired = grant.expiresAt !== null && grant.expiresAt * 1000 < Date.now();
    const token = grants.token?.grantId === grant.id ? grants.token.token : null;
    const holder = grant.subject?.name || grant.subject?.email || grant.email;
    // 1–3 redemptions is one person on their phone, laptop and work machine. Many
    // more, especially across countries, is the forwarding signal: a soft badge,
    // deliberately not an alarm.
    const spread = (activity?.distinctIps ?? 0) > 3 || (activity?.countries.length ?? 0) > 2;
    const failed = grants.error?.grantId === grant.id && grants.error.action !== 'activity' ? grants.error.message : null;
    return (_jsxs("article", { className: revoked ? cx.cardRevoked : cx.card, "data-grant": grant.id, children: [_jsxs("header", { className: cx.cardHead, children: [_jsx("h3", { children: grant.name ?? labels.noMemo ?? 'No memo' }), revoked ? (_jsx("span", { className: cx.tagDead, children: labels.revoked ?? 'revoked' })) : expired ? (_jsx("span", { className: cx.tagDead, children: labels.expired ?? 'expired' })) : (_jsxs("div", { className: cx.row, children: [disabled ? (_jsx("button", { className: cx.button, type: "button", disabled: busy, onClick: () => void grants.enable(grant.id), children: labels.enable ?? 'Enable' })) : (_jsx("button", { className: cx.button, type: "button", disabled: busy, onClick: () => void grants.disable(grant.id), children: labels.disable ?? 'Disable' })), _jsx(ConfirmButton, { className: cx.button, disabled: busy, label: labels.rotate ?? 'Rotate', confirm: labels.rotateConfirm ?? 'Kill the old link?', onConfirm: () => void grants.rotate(grant.id) }), _jsx(ConfirmButton, { className: cx.danger, disabled: busy, label: labels.revoke ?? 'Revoke', confirm: labels.revokeConfirm ?? 'End every session?', onConfirm: () => void grants.revoke(grant.id) })] }))] }), disabled && !revoked && (_jsxs("p", { className: cx.muted, children: [_jsx("span", { className: cx.tag, children: labels.disabled ?? 'disabled' }), ' ', labels.disabledNote ?? 'No new redemptions; anyone already in stays in.'] })), editing ? (_jsx(HolderEditor, { grant: grant, grants: grants, allowlist: allowlist, avatarEndpoint: avatarEndpoint, labels: labels, classNames: classNames, onDone: () => setEditing(false), ...(onHolderSaved ? { onSaved: onHolderSaved } : {}) })) : ((grant.subject || !revoked) && (_jsxs("p", { className: cx.holder, children: [grant.subject?.avatar && _jsx(Avatar, { src: grant.subject.avatar, name: holder, size: 20 }), " for ", holder ?? labels.someone ?? 'someone', !revoked && (_jsxs(_Fragment, { children: [' ', _jsx("button", { className: cx.linkish, type: "button", onClick: () => setEditing(true), children: labels.edit ?? 'edit' })] }))] }))), _jsxs("dl", { className: cx.facts, children: [_jsxs("div", { children: [_jsx("dt", { children: "scopes" }), _jsx("dd", { children: editScopes && !revoked ? (_jsx(ScopeChecks, { grant: grant, grants: grants, scopes: scopes, busy: busy, className: cx.check })) : (grant.scopes.map((id, i) => (_jsxs("span", { children: [i > 0 && ', ', scopes.find(s => s.id === id)?.label ?? id] }, id)))) })] }), _jsxs("div", { children: [_jsx("dt", { children: "redemptions" }), _jsxs("dd", { children: [grant.redeems, grant.maxRedeems !== null && ` / ${grant.maxRedeems}`] })] }), _jsxs("div", { children: [_jsx("dt", { children: "views" }), _jsx("dd", { children: activity?.views ?? 0 })] }), _jsxs("div", { children: [_jsx("dt", { children: "distinct clients" }), _jsxs("dd", { children: [activity?.distinctIps ?? 0, " ", spread && _jsx("span", { className: cx.tag, children: labels.widelyOpened ?? 'widely opened' })] })] }), _jsxs("div", { children: [_jsx("dt", { children: "last seen" }), _jsx("dd", { children: ago(grant.lastUsedAt) })] }), _jsxs("div", { children: [_jsx("dt", { children: "expires" }), _jsx("dd", { children: grant.expiresAt === null ? 'never' : new Date(grant.expiresAt * 1000).toLocaleDateString() })] })] }), editScopes && allowlist && !revoked && grant.email && (_jsx("p", { className: cx.muted, children: labels.allowlistKeepsScopes ?? `This doesn't change what ${grant.email} gets by signing in, if they're on the allowlist.` })), activity && activity.topPaths.length > 0 && (_jsxs("p", { className: cx.muted, children: ["mostly ", activity.topPaths.map(p => `${p.path} (${p.views})`).join(', '), activity.countries.length > 0 && ` · from ${activity.countries.join(', ')}`] })), failed && (_jsx("p", { className: cx.error, role: "alert", children: failed })), token ? (_jsx(GrantLink, { grant: grant, token: token, buildLink: buildLink, onDismiss: grants.dismissToken, labels: labels, classNames: classNames })) : (!revoked && _jsx("p", { className: cx.muted, children: labels.lostToken ?? 'Link shown once at mint. Rotate it for a fresh one if you lost it.' }))] }));
}
/**
 * Rename the link's holder or change their face after minting; a link minted
 * without an email can be given one, and the holder's existing session becomes
 * theirs with no new link to send.
 */
function HolderEditor({ grant, grants, allowlist, avatarEndpoint, labels, classNames, onDone, onSaved, }) {
    const cx = { ...DEFAULT_CLASSES, ...classNames };
    const l = labels ?? {};
    const [name, setName] = useState(grant.subject?.name ?? '');
    // `undefined` = keep the current face; `null` = clear it; a `data:` URI = replace.
    const [avatar, setAvatar] = useState(undefined);
    const [email, setEmail] = useState('');
    const [allow, setAllow] = useState(true);
    const bind = grant.email === null && email.trim() !== '';
    return (_jsxs("form", { className: cx.holderForm, onSubmit: async (e) => {
            e.preventDefault();
            const ok = await grants.update(grant.id, {
                subjectName: name,
                ...(avatar === undefined ? {} : { avatar }),
                ...(bind ? { email: email.trim(), ...(allowlist ? { allowlist: allow } : {}) } : {}),
            });
            if (ok) {
                onSaved?.();
                onDone();
            }
        }, children: [_jsxs("label", { children: [_jsx("span", { children: l.holderName ?? "Holder's name" }), _jsx("input", { className: cx.input, type: "text", value: name, onChange: e => setName(e.target.value), autoFocus: true })] }), grant.email === null && (_jsxs("label", { children: [_jsx("span", { children: l.holderEmail ?? 'Their email' }), _jsx("input", { className: cx.input, type: "email", value: email, placeholder: "optional", onChange: e => setEmail(e.target.value) })] })), bind && allowlist && (_jsxs("label", { className: cx.check, children: [_jsx("input", { type: "checkbox", checked: allow, onChange: e => setAllow(e.target.checked) }), _jsx("span", { children: l.allowlist ?? 'Also let this email sign in' })] })), avatarEndpoint && (_jsxs("div", { className: cx.avatarField, children: [_jsx("span", { children: l.face ?? 'Face' }), _jsx(AvatarField, { id: `oa-holder-avatar-${grant.id}`, endpoint: avatarEndpoint, value: avatar === undefined ? (grant.subject?.avatar ?? null) : avatar, onChange: setAvatar, email: grant.email, autoGravatar: false, name: name.trim() || null, size: 36, ...(classNames?.avatar ? { classNames: classNames.avatar } : {}) })] })), _jsxs("div", { className: cx.row, children: [_jsx("button", { className: cx.button, type: "submit", disabled: grants.pending[grant.id] !== undefined, children: l.save ?? 'Save' }), _jsx("button", { className: cx.button, type: "button", onClick: onDone, children: l.cancel ?? 'Cancel' })] })] }));
}
/** A mint form over the list of links, composed from the exported parts. */
export function GrantsPanel({ client, controller, scopes, buildLink, pollMs, onMinted, onChanged, mintIntro, listIntro, mintHeading = 'Mint a share link', listHeading = 'Share links', emptyLabel = 'None yet.', labels, cardLabels, editScopes = false, classNames, defaultMemo, expiryDays, defaultExpiryDays, maxRedeems, allowlist, avatarEndpoint, }) {
    const cx = { ...DEFAULT_CLASSES, ...classNames };
    const grants = useGrants(controller ? { controller, pollMs } : { client: client, pollMs });
    const listFailed = grants.error?.action === 'refresh' ? grants.error.message : null;
    return (_jsxs("div", { className: cx.panel, children: [_jsxs("section", { className: classNames?.section, children: [_jsx("h2", { children: mintHeading }), mintIntro, _jsx(GrantMintForm, { scopes: scopes, busy: grants.minting, error: grants.error?.action === 'mint' ? grants.error.message : null, onMint: async (input) => {
                            const grant = await grants.mint(input);
                            if (grant) {
                                onMinted?.(grant);
                                onChanged?.();
                            }
                            return grant;
                        }, labels: labels, classNames: classNames, ...(defaultMemo === undefined ? {} : { defaultMemo }), ...(expiryDays === undefined ? {} : { expiryDays }), ...(defaultExpiryDays === undefined ? {} : { defaultExpiryDays }), ...(maxRedeems === undefined ? {} : { maxRedeems }), ...(allowlist === undefined ? {} : { allowlist }), ...(avatarEndpoint === undefined ? {} : { avatarEndpoint }) })] }), _jsxs("section", { className: classNames?.section, children: [_jsx("h2", { children: listHeading }), listIntro, listFailed && (_jsx("p", { className: cx.error, role: "alert", children: listFailed })), !grants.loaded && grants.loading && _jsx("p", { className: cx.muted, children: "Loading\u2026" }), grants.loaded && grants.grants.length === 0 && _jsx("p", { className: cx.muted, children: emptyLabel }), _jsx("div", { className: cx.list, children: grants.grants.map(grant => (_jsx(GrantCard, { grant: grant, grants: grants, scopes: scopes, editScopes: editScopes, buildLink: buildLink, allowlist: allowlist ?? false, labels: cardLabels, classNames: classNames, ...(onChanged ? { onHolderSaved: onChanged } : {}), ...(avatarEndpoint === undefined ? {} : { avatarEndpoint }) }, grant.id))) })] })] }));
}
