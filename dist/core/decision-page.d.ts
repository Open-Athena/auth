/**
 * The HTML an admin sees after clicking a link in their mail.
 *
 * This endpoint is reached from a mail client, outside the app's SPA, so the
 * library has to ship real markup rather than JSON — a bare 200 with
 * `{"kind":"decided"}` is not an answer to someone who just clicked "Approve".
 * It stays deliberately plain: no external assets, no fonts to fetch, readable
 * in both colour schemes, and overridable wholesale via `decisionLinks.render`
 * for apps that want their own chrome.
 */
import type { DecisionView } from './decisions.js';
export interface DecisionPageOptions {
    appName?: string;
    /** Where the form posts. Defaults to the current URL. */
    action?: string;
}
export declare function renderDecisionPage(view: DecisionView, opts?: DecisionPageOptions): Response;
