import { type Whoami } from './types.js';
/** Where the avatar comes from on save. `keep` leaves the current one untouched. */
export type AvatarChoice = 'keep' | 'upload' | 'url' | 'github' | 'gravatar' | 'clear';
export interface ProfilePanelProps {
    /** Default `/api/auth/profile`. */
    endpoint?: string;
    /** The current identity, to seed the name fields and preview the avatar. */
    whoami?: Whoami | null;
    /** Called after a successful save (the whoami cache is refetched regardless). */
    onSaved?: () => void;
    classNames?: Partial<Record<'form' | 'field' | 'label' | 'input' | 'select' | 'button' | 'message' | 'preview', string>>;
    labels?: Partial<Record<'first' | 'last' | 'avatar' | 'save' | 'saving' | 'saved' | keyof Record<AvatarChoice, string>, string>>;
}
/**
 * Let a signed-in principal set their own display name and face. Unstyled, like
 * the rest of `react/`: every visible string and class is a prop.
 *
 * The avatar is always copied server-side (`PUT /api/profile` calls
 * `resolveAvatar`/`validateUploadedImage`), so nothing here ever persists a live
 * third-party URL — a paste of an image URL is fetched once and inlined, not
 * rendered from its origin on every view.
 */
export declare function ProfilePanel({ endpoint, whoami, onSaved, classNames, labels, }: ProfilePanelProps): import("react").JSX.Element;
