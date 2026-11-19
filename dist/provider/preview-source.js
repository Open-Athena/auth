/**
 * Where a preview client's builds come from (specs/done/preview-pr-context.md): an admin-set
 * `previewSource` maps a preview host's first label (`pr-9`) to a GitHub PR, which the broker looks up
 * itself, with its own credential, so the consent page can say which PR it's vouching for. Nothing here
 * comes from the preview's own code: that's the code the page exists to warn about.
 */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const LABEL_PART = /^[a-z0-9-]*$/;
/** Up to this many digits for `{n}`: GitHub's numbers are far smaller, and a label stays under 63 characters. */
const N_DIGITS = 9;
/** What's wrong with this source, or null. */
export function previewSourceProblem(s) {
    if (s === null || typeof s !== 'object' || Array.isArray(s))
        return 'a source is { provider, repo, label }';
    const { provider, repo, label, ...rest } = s;
    if (Object.keys(rest).length)
        return `unexpected field: ${Object.keys(rest)[0]}`;
    if (provider !== 'github')
        return "provider: only 'github'";
    if (typeof repo !== 'string' || !REPO.test(repo) || repo.endsWith('/.') || repo.endsWith('/..'))
        return 'repo: owner/name';
    if (typeof label !== 'string')
        return 'label: a template like pr-{n}';
    const parts = label.split('{n}');
    if (parts.length !== 2)
        return 'label: exactly one {n}';
    const [before, after] = parts;
    if (!LABEL_PART.test(before) || !LABEL_PART.test(after))
        return 'label: lower-case letters, digits and hyphens around {n}';
    if (before.startsWith('-') || after.endsWith('-') || label.includes('--'))
        return "label: no leading, trailing or doubled hyphens (they can't form every PR's host)";
    if (before.length + after.length + N_DIGITS > 63)
        return 'label: too long for a DNS label';
    return null;
}
/** The PR number a host's first label names under `label`, or null (`dev`, a deployment hash, another pattern). */
export function prNumberFor(label, host) {
    const [before, after] = label.split('{n}');
    const first = host.split('.')[0] ?? '';
    if (!first.startsWith(before) || !first.endsWith(after) || first.length <= before.length + after.length)
        return null;
    const digits = first.slice(before.length, first.length - after.length);
    return new RegExp(`^[1-9][0-9]{0,${N_DIGITS - 1}}$`).test(digits) ? Number(digits) : null;
}
const CACHE_MAX = 200;
const AVATAR = /^https:\/\/avatars\.githubusercontent\.com\//;
const str = (v) => (typeof v === 'string' ? v : null);
/** GitHub's `GET /repos/{repo}/pulls/{n}`, read into a `PreviewPr`, or null if it isn't one. */
export function readPr(repo, n, body) {
    const b = body;
    if (!b || b.number !== n)
        return null;
    const login = str(b.user?.login);
    const title = str(b.title);
    const headRef = str(b.head?.ref);
    const sha = str(b.head?.sha);
    const baseRef = str(b.base?.ref);
    const updatedAt = str(b.updated_at);
    if (!login || title === null || !headRef || !sha || !baseRef || !updatedAt)
        return null;
    const avatar = str(b.user?.avatar_url);
    return {
        repo,
        number: n,
        title,
        author: { login, avatarUrl: avatar && AVATAR.test(avatar) ? avatar : null },
        head: { ref: headRef, sha, repo: str(b.head?.repo?.full_name) },
        base: { ref: baseRef },
        state: b.merged_at ? 'merged' : b.state === 'closed' ? 'closed' : b.draft === true ? 'draft' : 'open',
        updatedAt,
    };
}
const PROTOCOL = 'cf-preview-v1';
const WORKFLOW = 'github-actions[bot]';
const SHA = /^[0-9a-f]{40}$/;
/** The newest of `deployments` (GitHub's list, newest first) that records PR `n` of `repo` at `host`. */
export function previewRecord(deployments, repo, n, host) {
    if (!Array.isArray(deployments))
        return null;
    for (const d of deployments) {
        const p = d?.payload;
        if (d?.creator?.login !== WORKFLOW || !p || p.protocol !== PROTOCOL || p.pr !== n || p.hostname !== host)
            continue;
        if (typeof p.repository !== 'string' || p.repository.toLowerCase() !== repo.toLowerCase())
            continue;
        if (!Number.isSafeInteger(d.id))
            continue;
        return { id: d.id, sha: typeof p.verified_sha === 'string' && SHA.test(p.verified_sha) ? p.verified_sha : '', at: str(d.created_at) ?? '' };
    }
    return null;
}
/** `PreviewPrs` over GitHub's REST API, cached in this isolate's memory. */
export function githubPreviewPrs({ token, ttlS = 60, fetch: f = fetch, now = Date.now, timeoutMs = 5000 } = {}) {
    const cache = new Map();
    const get = (path) => f(`https://api.github.com/repos/${path}`, {
        headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'oa-auth-broker',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
    });
    const json = async (path) => {
        const r = await get(path);
        if (!r.ok)
            throw new Error(`GitHub ${r.status}`);
        return r.json();
    };
    /** The head's own records first; if none is this host's, the repo's newest 100 (a preview behind its head). */
    async function deployment(pr, host) {
        try {
            const record = previewRecord(await json(`${pr.repo}/deployments?sha=${pr.head.sha}&per_page=100`), pr.repo, pr.number, host) ??
                previewRecord(await json(`${pr.repo}/deployments?per_page=100`), pr.repo, pr.number, host);
            if (!record)
                return { status: 'unconfirmed' };
            const [latest] = (await json(`${pr.repo}/deployments/${record.id}/statuses?per_page=1`));
            return latest?.state === 'success' && record.sha ? { status: 'live', sha: record.sha, at: record.at } : { status: 'unconfirmed' };
        }
        catch {
            return { status: 'unavailable' };
        }
    }
    return async (source, n, host) => {
        const key = `${source.repo}#${n}@${host}`;
        const hit = cache.get(key);
        if (hit && now() - hit.at < ttlS * 1000)
            return hit.lookup;
        let lookup;
        try {
            const r = await get(`${source.repo}/pulls/${n}`);
            const pr = r.ok ? readPr(source.repo, n, await r.json()) : null;
            lookup = r.status === 404 ? { status: 'missing' }
                : pr ? { status: 'found', pr, deployment: pr.state === 'open' || pr.state === 'draft' ? await deployment(pr, host) : { status: 'unconfirmed' } }
                    : { status: 'unavailable' };
        }
        catch {
            lookup = { status: 'unavailable' };
        }
        // A stale answer is dropped even when GitHub fails now: the page then says it couldn't check. A PR found while
        // its deployments couldn't be checked isn't kept either, so the next sign-in asks again.
        cache.delete(key);
        if (lookup.status !== 'unavailable' && !(lookup.status === 'found' && lookup.deployment.status === 'unavailable')) {
            cache.set(key, { at: now(), lookup });
            if (cache.size > CACHE_MAX)
                cache.delete(cache.keys().next().value);
        }
        return lookup;
    };
}
