/** One row as the `<basePath>/allowed` endpoint returns it. */
export interface AllowedEntry {
    email: string;
    scopes: string[];
    source: string;
    note: string | null;
    addedBy: string | null;
    updatedAt: number;
}
export interface AllowlistPanelProps {
    /** Default `/api/auth/allowed`. */
    endpoint?: string;
    /**
     * Scopes to grant a hand-added email. Defaults to `[]` — set this to your
     * app's view scope (e.g. `['view']`) so the add form doesn't need a scopes
     * field. Rows a directory sync wrote keep whatever scopes it gave them.
     */
    defaultScopes?: readonly string[];
    /** Called after any successful add, remove, or sync. */
    onChanged?: () => void;
    /**
     * Show a "Sync now" button that POSTs `<endpoint>/sync` (the route an app
     * mounts with `authRoutes(gate, { allowlist, sync })`) and reloads. Off by
     * default: only meaningful when the app has a directory sync wired.
     */
    sync?: boolean;
    classNames?: Partial<Record<'root' | 'table' | 'row' | 'cell' | 'source' | 'form' | 'input' | 'button' | 'remove' | 'sync' | 'message' | 'empty', string>>;
    labels?: Partial<Record<'email' | 'add' | 'adding' | 'remove' | 'empty' | 'synced' | 'manual' | 'sync' | 'syncing' | 'syncDone', string>>;
}
/**
 * Manage the SSO allowlist: list allowed emails, add one, remove one. Unstyled
 * like the rest of `react/` — every visible string and class is a prop.
 *
 * A row's `source` distinguishes a hand-added address (`manual`) from one a
 * directory sync owns (`sync:…`); both are removable here, but a sync will
 * re-add the ones it manages on its next run, so removing a synced member is
 * only durable if you also take them out of the upstream group.
 */
export declare function AllowlistPanel({ endpoint, defaultScopes, onChanged, sync, classNames, labels, }: AllowlistPanelProps): import("react").JSX.Element;
