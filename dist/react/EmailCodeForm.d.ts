import { type ReactNode } from 'react';
export type EmailCodeState = 'email' | 'sending' | 'code' | 'verifying' | 'error';
export interface EmailCodeFormProps {
    /** Where `POST {email}` starts the flow. Default `/api/auth/email/start`. */
    startEndpoint?: string;
    /** Where `POST {id, code}` mints the session. Default `/api/auth/email/code`. */
    verifyEndpoint?: string;
    /** Called after the code verifies — refetch `useWhoami` so the wall drops. */
    onSignedIn?: () => void;
    /** Pre-fill the address (e.g. a Google-verified one after a denied redirect). */
    defaultEmail?: string;
    classNames?: Partial<Record<'form' | 'field' | 'label' | 'input' | 'button' | 'message' | 'back', string>>;
    labels?: Partial<Record<'email' | 'code' | 'send' | 'sending' | 'verify' | 'verifying' | 'back', ReactNode>>;
    /** Copy shown once a code has been sent. `email` is interpolated by the caller if desired. */
    sentHint?: (email: string) => ReactNode;
}
/**
 * The wall's third affordance: sign in with a code emailed to you, for the tail
 * of users who can't (or won't) use Google. Two steps — enter an address, then
 * enter the 6-digit code that arrives — because typing the code back into *this*
 * tab is what rescues the cross-device case (the mail is on your phone). The
 * matching magic link in the same email is the one-click path when it's the
 * same device.
 *
 * The server answers `start` identically whether or not the address is allowed,
 * so this form can't be used to probe the allowlist; a genuinely-not-allowed
 * person simply never receives a code and uses request-access instead.
 */
export declare function EmailCodeForm({ startEndpoint, verifyEndpoint, onSignedIn, defaultEmail, classNames, labels, sentHint, }: EmailCodeFormProps): import("react").JSX.Element;
