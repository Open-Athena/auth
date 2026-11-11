/**
 * Which callback URLs a client may be sent to. Exact matches, plus one narrow
 * pattern for PR-preview clients (`ProviderClient.preview`): a registered
 * `https://*.<suffix>/<path>` admits `https://<label>.<suffix>/<path>`, where
 * `<label>` is exactly one DNS label (a Pages branch alias such as `pr-12`),
 * and nothing else about the URL varies: no port, query or fragment, and the
 * URL must already be in normal form, since the token endpoint compares it
 * exactly. Which suffixes may carry a pattern at all is the deployment's
 * allowlist (`redirectUriProblem`'s `previewSuffixes`), not the client's.
 */
/** A registered `https://*.<suffix>/<path>`: its suffix and path, or null if it isn't a well-formed pattern. */
export declare function previewPattern(raw: string): {
    suffix: string;
    path: string;
} | null;
/**
 * Whether `uri` is one of `registered`: exactly, or, for a preview client
 * only, under one of its patterns. A pattern string is never an exact match
 * for itself.
 */
export declare function redirectAllowed(registered: readonly string[], uri: string, preview: boolean): boolean;
