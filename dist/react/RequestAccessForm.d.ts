export type RequestState = 'idle' | 'submitting' | 'pending' | 'invalid' | 'rate-limited' | 'error';
export interface RequestAccessFormProps {
    /** Default `/api/auth/request`. */
    endpoint?: string;
    /** Must match the server's `honeypotField`. Default `website`. */
    honeypotField?: string;
    /**
     * Ask for a name: one free-text field, posted as `name` and stored as the
     * request's `subject.name` — the same `Subject` a grant carries, so approval
     * yields a grant that greets a person. Default true.
     */
    askName?: boolean;
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
    labels?: Partial<Record<'email' | 'name' | 'note' | 'submit' | 'submitting', string>>;
}
/**
 * The wall's second affordance, for everyone who isn't staff. Unstyled: every
 * visible string and class is a prop, because the wall's copy is exactly the
 * part each app needs to own.
 */
export declare function RequestAccessForm({ endpoint, honeypotField, askName, askNote, notePlaceholder, defaultEmail, onSubmitted, classNames, labels, }: RequestAccessFormProps): import("react").JSX.Element;
