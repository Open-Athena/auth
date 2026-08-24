/**
 * Resend as a `SendEmail`.
 *
 * A dozen lines, which is the point of the interface being small: swapping to
 * Postmark or SES is a sibling file, not a refactor. Chosen over the
 * alternatives because it needs no SDK — one `fetch` to one endpoint — which
 * matters in a Worker.
 *
 * Note MailChannels' free Workers integration ended in 2024, so an ESP is a
 * real dependency now rather than a footnote.
 */
import type { SendEmail } from '../core/email.js';
export interface ResendOptions {
    /** `re_...`. Scope it to the one domain you send from if the provider allows. */
    apiKey: string;
    /** Default `from`, overridable per message. */
    from?: string;
    fetch?: typeof globalThis.fetch;
}
export declare function resendEmail({ apiKey, from: defaultFrom, fetch }: ResendOptions): SendEmail;
