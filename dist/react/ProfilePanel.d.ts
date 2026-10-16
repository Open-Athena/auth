import { type AvatarFieldProps } from './AvatarField.js';
import { type Whoami } from './types.js';
export interface ProfilePanelProps {
    /** Default `/api/auth/profile`. */
    endpoint?: string;
    /** The avatar preview endpoint. Default: `endpoint` with `/profile` swapped for `/avatar`. */
    avatarEndpoint?: string;
    /** The current identity, to seed the name field and preview the avatar. */
    whoami?: Whoami | null;
    /** Called after a successful save (the whoami cache is refetched regardless). */
    onSaved?: () => void;
    classNames?: Partial<Record<'form' | 'field' | 'label' | 'input' | 'button' | 'message' | 'preview', string>> & {
        avatar?: AvatarFieldProps['classNames'];
    };
    labels?: Partial<Record<'name' | 'avatar' | 'save' | 'saving' | 'saved', string>> & {
        avatarField?: AvatarFieldProps['labels'];
    };
}
/**
 * Let a signed-in principal set their own display name and face. Unstyled, like
 * the rest of `react/`: every visible string and class is a prop.
 *
 * The face comes from `<AvatarField>` (a profile, an image address, an upload,
 * or Gravatar on request), and is copied server-side on save — nothing here
 * ever persists a live third-party URL.
 */
export declare function ProfilePanel({ endpoint, avatarEndpoint, whoami, onSaved, classNames, labels, }: ProfilePanelProps): import("react").JSX.Element;
