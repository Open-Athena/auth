/**
 * Where a preview client's builds come from (specs/done/preview-pr-context.md): an admin-set
 * `previewSource` maps a preview host's first label (`pr-9`) to a GitHub PR, which the broker looks up
 * itself, with its own credential, so the consent page can say which PR it's vouching for. Nothing here
 * comes from the preview's own code: that's the code the page exists to warn about.
 */
export interface PreviewSource {
    provider: 'github';
    /** `owner/name`. */
    repo: string;
    /** The host label for PR n: lower-case letters, digits and hyphens around exactly one `{n}`, e.g. `pr-{n}`. */
    label: string;
}
/** A PR as the consent page shows it. Everything but `number` is GitHub's, and `title` is the author's. */
export interface PreviewPr {
    repo: string;
    number: number;
    title: string;
    author: {
        login: string;
        avatarUrl: string | null;
    };
    /** `repo` is the head branch's repository (`owner/name`): another one means a fork; null, a deleted one. */
    head: {
        ref: string;
        sha: string;
        repo: string | null;
    };
    base: {
        ref: string;
    };
    state: 'open' | 'draft' | 'closed' | 'merged';
    /** ISO 8601, as GitHub gives it. */
    updatedAt: string;
}
export type PreviewPrLookup = {
    status: 'found';
    pr: PreviewPr;
}
/** GitHub answered that there's no such PR. */
 | {
    status: 'missing';
}
/** GitHub couldn't be asked, or didn't answer usefully. */
 | {
    status: 'unavailable';
};
/** Looks up PR `n` of a preview client's source. */
export type PreviewPrs = (source: PreviewSource, n: number) => Promise<PreviewPrLookup>;
/** What's wrong with this source, or null. */
export declare function previewSourceProblem(s: unknown): string | null;
/** The PR number a host's first label names under `label`, or null (`dev`, a deployment hash, another pattern). */
export declare function prNumberFor(label: string, host: string): number | null;
export interface GithubPreviewPrsOptions {
    /**
     * A read-only token (`pull_requests: read` on the registered repos). Without one, public repos only, at
     * GitHub's anonymous rate (60 an hour per IP, shared with whatever else runs there). A private repo the
     * token can't read answers 404, which reads as "no such PR".
     */
    token?: string;
    /** How long a found or missing PR is reused (default 60 s). Failures aren't cached. */
    ttlS?: number;
    fetch?: typeof fetch;
    /** Epoch ms. */
    now?: () => number;
    /** Per request (default 5 s). */
    timeoutMs?: number;
}
/** GitHub's `GET /repos/{repo}/pulls/{n}`, read into a `PreviewPr`, or null if it isn't one. */
export declare function readPr(repo: string, n: number, body: unknown): PreviewPr | null;
/** `PreviewPrs` over GitHub's REST API, cached in this isolate's memory. */
export declare function githubPreviewPrs({ token, ttlS, fetch: f, now, timeoutMs }?: GithubPreviewPrsOptions): PreviewPrs;
