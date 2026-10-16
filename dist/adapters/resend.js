const ENDPOINT = 'https://api.resend.com/emails';
export function resendEmail({ apiKey, from: defaultFrom, fetch = globalThis.fetch }) {
    return async (msg) => {
        const from = msg.from ?? defaultFrom;
        if (!from)
            return { ok: false, error: 'no `from` address configured' };
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                from,
                to: Array.isArray(msg.to) ? msg.to : [msg.to],
                subject: msg.subject,
                text: msg.text,
                ...(msg.html ? { html: msg.html } : {}),
                ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
            }),
        }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
        if (!res.ok) {
            // The body carries Resend's own message ("domain is not verified" is the
            // one everybody hits first), and it must reach the caller — a magic-link
            // flow that silently sends nothing is the worst failure mode here.
            const detail = await res.text().catch(() => '');
            return { ok: false, error: `resend ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` };
        }
        const body = (await res.json().catch(() => ({})));
        return { ok: true, ...(body.id ? { id: body.id } : {}) };
    };
}
