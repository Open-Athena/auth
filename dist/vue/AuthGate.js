import { defineComponent } from 'vue';
import { useWhoami } from './useWhoami.js';
/** Identity presentation only. Authorization remains the server's responsibility. */
export const AuthGate = defineComponent({
    name: 'AuthGate',
    slots: Object,
    props: {
        options: { type: Object, default: () => ({}) },
    },
    setup(props, { slots }) {
        // Options are setup-time configuration; remount to change clients/endpoints.
        const auth = useWhoami({ exchange: {}, ...props.options });
        return () => {
            const context = { whoami: auth.whoami.value, loading: auth.loading.value, error: auth.error.value, reason: auth.reason.value, refetch: auth.refetch, signOut: auth.signOut };
            if (context.loading)
                return slots.loading?.(context);
            // Without an error slot, the wall receives the error and retry action.
            if (context.error)
                return slots.error ? slots.error({ ...context, error: context.error }) : slots.unauthenticated?.(context);
            if (context.whoami == null)
                return slots.unauthenticated?.(context);
            return slots.default?.({ ...context, whoami: context.whoami });
        };
    },
});
