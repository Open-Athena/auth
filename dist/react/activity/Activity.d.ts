export interface ActivityProps {
    /** Staff-only activityRoutes base path. Requires a QueryClientProvider. */
    endpoint?: string;
    className?: string;
}
export declare function ActivityList({ endpoint, className }: ActivityProps): import("react").JSX.Element;
export declare function ActivityKindSettings({ endpoint, className }: ActivityProps): import("react").JSX.Element;
export declare function ActivityAdmin(props: ActivityProps): import("react").JSX.Element;
