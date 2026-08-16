export type RequestState = 'idle' | 'submitting' | 'pending' | 'invalid' | 'rate-limited' | 'error';
export interface RequestAccessFormProps {
    /** Default `/api/auth/request`. */
    endpoint?: string;
    /** Must match the server's `honeypotField`. Default `website`. */
    honeypotField?: string;
    askName?: boolean;
    askNote?: boolean;
    notePlaceholder?: string;
    onSubmitted?: (state: RequestState) => void;
    classNames?: Partial<Record<'form' | 'field' | 'label' | 'input' | 'button' | 'message', string>>;
    labels?: Partial<Record<'email' | 'name' | 'note' | 'submit' | 'submitting', string>>;
}
/**
 * The wall's second affordance, for everyone who isn't staff. Unstyled: every
 * visible string and class is a prop, because the wall's copy is exactly the
 * part each app needs to own.
 */
export declare function RequestAccessForm({ endpoint, honeypotField, askName, askNote, notePlaceholder, onSubmitted, classNames, labels, }: RequestAccessFormProps): import("react").JSX.Element;
