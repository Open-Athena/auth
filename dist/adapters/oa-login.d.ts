/**
 * "Sign in with OA" (specs/oa-login-rp.md): OA's broker (`OA_LOGIN_ISSUER`, login.oa.dev) as the OIDC provider for a
 * gate, its start and callback routes, and the silent sign-in that sends a person's unauthenticated page visit to the
 * broker once before the wall. Request in, Response out: a Worker or a Pages Function uses it the same way. Each app
 * supplies its gate, what it walls, and (where they differ from the defaults) its paths. Built in disky
 * (`packages/pages-kit/src/oa.ts`) and moved here for every OA app.
 *
 * Silent sign-in: the broker holding a session sends the person straight back signed in; otherwise they land where
 * they were with `?sso=<why>`, and the app shows its wall. Nothing here reads storage: a session is judged by the app's
 * `presents` (its signature), so a signed-in visit pays nothing.
 *
 * `SKIP_COOKIE` is what stops a repeat, with one of two values:
 * - `attempt` (`ATTEMPT_TTL_S`): this browser just tried. Short, so a sign-in at the broker elsewhere still takes on a
 *   later visit, and a person with no broker session sees at most one bounce per five minutes.
 * - `signout` (`SIGNED_OUT_TTL_S`): this browser deliberately signed out. The broker's session survives an app logout
 *   (by design: `oa/auth`'s `specs/cross-service-sso.md`), so an attempt would sign them straight back in. It lasts until
 *   they resume: a click on "Sign in with OA" (`/auth/oa` without `prompt=none`), or any completed sign-in
 *   (`clearedOnSignIn`).
 *
 * With cookies blocked the `?sso=` marker alone stops the second attempt on the way back. A reload is then one more
 * bounce, never a loop.
 */
import type { Gate } from '../core/gate.js';
import { type OidcOptions } from './oidc.js';
/** The vars that configure the broker: the issuer and a client (any unset = not configured). The preview pair is the
 *  deployment's preview client at the broker (`<client id>-preview`, its callback the one-label pattern
 *  `https://*.<project subdomain>/auth/oa/callback`), set only in the Pages preview environment: the only client a
 *  preview host (`OaLoginHost.preview`) uses. */
export interface OaLoginEnv {
    OA_LOGIN_ISSUER?: string;
    OA_LOGIN_CLIENT_ID?: string;
    OA_LOGIN_CLIENT_SECRET?: string;
    OA_LOGIN_PREVIEW_CLIENT_ID?: string;
    OA_LOGIN_PREVIEW_CLIENT_SECRET?: string;
}
export interface OidcCfg {
    gate: Gate;
    clientId: string;
    clientSecret: string;
    redirectUri: OidcOptions['redirectUri'];
}
/** Where this app's sign-in routes and pages are. Defaults: `/auth/oa`, `/auth/oa/callback`, `/signin`, `/`. */
export interface OaLoginPaths {
    /** The start route (`oaStart`), and where `silentAttempt` sends a visit. */
    startPath?: string;
    /** The callback route (`oaCallback`), registered exactly at the broker. */
    callbackPath?: string;
    /** Where an explicit sign-in's failure lands, as `?error=oa:<reason>` (a silent one's as `?sso=<why>` when the
     *  adapter can't vouch for the state). Never itself an attempt: pass it in `SilentApp.notWalled`. */
    signInPath?: string;
    /** Where a failed silent exchange lands, as `?sso=error`. */
    home?: string;
}
export type OaLoginCfg = OidcCfg & Required<Pick<OidcOptions, 'provider' | 'nonceCookieName' | 'accountHintCookie'>> & {
    signInPath: string;
    home: string;
};
/** What the app knows about the request's host. This module doesn't classify hosts; the app does. */
export interface OaLoginHost extends OaLoginPaths {
    /** A PR preview's branch host: the preview client with a redirect on the request's own origin, or nothing. */
    preview?: boolean;
    /** The nonce cookie's name (default `OA_NONCE_COOKIE`), e.g. a `__Host-` one on https. */
    nonceCookieName?: string;
    /** The adapter's account-hint cookie for broker sign-ins (e.g. `OA_HINT_COOKIE`): what `rememberAccount` reads the
     *  address from, and the `login_hint` a later attempt sends. Default none. */
    accountHintCookie?: string | false;
}
export declare const OA_START_PATH = "/auth/oa";
export declare const OA_CALLBACK_PATH = "/auth/oa/callback";
export declare const OA_SIGNIN_PATH = "/signin";
export declare const OA_NONCE_COOKIE = "oa_login_nonce";
/** The adapter config for "Sign in with OA" (`/auth/oa` + its callback): OA's broker as the OIDC provider, or null where
 *  it isn't configured (no gate, or `OA_LOGIN_ISSUER` or the host's client id / secret unset).
 *  No `hd`: the broker admits only its Workspace; the gate's policy decides admission as for every other path. Its own
 *  nonce cookie (a Google round trip in another tab keeps its own) and its own account-hint cookie where the app names
 *  one (`host.accountHintCookie`, never Google's: those feed Google's chooser), which `rememberAccount` reads.
 *
 *  On a preview host (`host.preview`) the client is the preview pair alone, with `redirectFromOrigin`: the broker checks
 *  the concrete callback against that client's one-label pattern. Without the pair it is null (no button, 404), never
 *  the deployment's own client. */
export declare function oaLoginOptions(gate: Gate | null, env: OaLoginEnv, request: Request, host?: OaLoginHost): OaLoginCfg | null;
export declare const OA_HINT_COOKIE = "oa_login_hint";
export declare const OA_WHO_COOKIE = "oa_login_who";
/** `res` (a completed broker sign-in) plus a signed `whoCookie` naming the address the adapter just wrote to
 *  `hintCookie`. The hint is client-controlled on later requests; this is what the wall trusts to show a name and face
 *  ("Continue as …"), so only a browser that signed in as an address is shown that address's profile. Like Google's
 *  hints it outlives sign-out: it says who was here last, never who is here. */
export declare function rememberAccount(res: Response, request: Request, { hintCookie, whoCookie, secret }: {
    hintCookie: string;
    whoCookie: string;
    secret: string;
}): Promise<Response>;
/** The address `rememberAccount` signed for this browser, or null (none, forged, expired). */
export declare function rememberedAccount(request: Request, whoCookie: string, secret: string): Promise<string | null>;
/** The addresses an adapter's account-hint cookie pair (`name`, `name_accounts`) remembers, newest first, as the
 *  adapter reads them: presentation only, never an identity. */
export declare function hintedAccounts(request: Request, name: string | false): string[];
export declare const SKIP_COOKIE = "oa_sso_skip";
export declare const ATTEMPT_TTL_S: number;
/** Chrome caps cookie lifetimes at 400 days: as long as one can last, not a judgement about how long is enough. */
export declare const SIGNED_OUT_TTL_S: number;
/** What an app tells the silent attempt, each asked only when the cheaper checks before it haven't decided. */
export interface SilentApp {
    /** Paths a document navigation can reach that aren't walled pages. */
    notWalled: RegExp;
    /** Nothing is walled here at all (a public deployment). */
    anonymous: () => boolean;
    /** The broker is configured (`oaLoginOptions` non-null). */
    configured: () => boolean;
    /** The request already carries a credential that passes. */
    presents: () => Promise<boolean>;
    /** The start route to send the visit to (default `/auth/oa`, `OaLoginPaths.startPath`). */
    startPath?: string;
}
/** The redirect to the broker for this request, or null to serve it as ever. */
export declare function silentAttempt(request: Request, app: SilentApp): Promise<Response | null>;
/** Whether this callback answers a silent attempt: the browser's marker is still here (an explicit `/auth/oa` clears
 *  it, `resumed`). */
export declare const attemptInFlight: (request: Request) => boolean;
/** Logout's response, this browser marked no-attempt until it resumes. Unconfigured: `res` itself. */
export declare const markedSignedOut: (request: Request, configured: boolean, res: Response) => Response;
/** An explicit `/auth/oa` start's response, the no-attempt state cleared: the person has asked to sign in. */
export declare const resumed: (request: Request, res: Response) => Response;
/** Any route's response: one minting the session `sessionCookieName` (every sign-in path converges on it) also clears
 *  the no-attempt state. Everything else, and everything on an unconfigured deployment, is `res` itself. */
export declare function clearedOnSignIn(request: Request, sessionCookieName: string, configured: () => boolean, res: Response): Response;
/** `/auth/oa`: 302 to the broker, which signs the person in with Google (openathena.ai only) or, holding its own
 *  session, sends them straight back. `?next`, `?prompt`, `?account=choose` pass through. Not configured: 404. Without
 *  `prompt=none` this is a person asking to sign in, which ends any suppression of the silent attempt. */
export declare function oaStart(cfg: OaLoginCfg | null, request: Request): Promise<Response>;
/** `/auth/oa/callback`: verify state + nonce, trade the code for the broker's id_token, verify it against the broker's
 *  JWKS, then `gate.signIn(email)` → app session → 302 to `?next` (`signedIn` may decorate that response).
 *
 *  An explicit attempt's failure (the broker's `error=`, or the adapter's own) lands on `/signin?error=oa:<reason>`,
 *  which says why. A silent one's is no error: it lands on the wall, where they were, by way of the adapter
 *  (`<next>?sso=<why>`), or on a quiet `/signin` or `/` when the adapter can't vouch for the state, as with cookies
 *  blocked. `/signin` and `?sso=` never bounce again. */
export declare function oaCallback(cfg: OaLoginCfg | null, request: Request, signedIn?: (res: Response) => Response): Promise<Response>;
