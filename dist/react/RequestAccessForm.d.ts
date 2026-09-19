export type RequestState = 'idle' | 'submitting' | 'pending' | 'invalid' | 'rate-limited' | 'error';
export interface RequestAccessFormProps {
    /** Default `/api/auth/request`. */
    endpoint?: string;
    /** Must match the server's `honeypotField`. Default `website`. */
    honeypotField?: string;
    /**
     * `true` — one free-text "Name" field (posted as `name`).
     * `'split'` — separate First / Last, posted as `first`/`last` and stored as
     * the same `Subject` a grant carries, so approval yields a grant that knows a
     * person. Prefer `true` unless you specifically need the parts: plenty of
     * people don't have a two-part name, and a required Last is how you lose them.
     * `false` — don't ask.
     */
    askName?: boolean | 'split';
    askNote?: boolean;
    notePlaceholder?: string;
    /**
     * Pre-fill the email field — e.g. the Google-verified address after a denied
     * sign-in, so approval acts on an address Google vouched for rather than one
     * that was typed. Not read-only: the person may still correct it.
     */
    defaultEmail?: string;
    onSubmitted?: (state: RequestState) => void;
    classNames?: Partial<Record<'form' | 'field' | 'label' | 'input' | 'button' | 'message', string>>;
    labels?: Partial<Record<'email' | 'name' | 'first' | 'last' | 'note' | 'submit' | 'submitting', string>>;
}
/**
 * The wall's second affordance, for everyone who isn't staff. Unstyled: every
 * visible string and class is a prop, because the wall's copy is exactly the
 * part each app needs to own.
 */
export declare function RequestAccessForm({ endpoint, honeypotField, askName, askNote, notePlaceholder, defaultEmail, onSubmitted, classNames, labels, }: RequestAccessFormProps): import("react").JSX.Element;
