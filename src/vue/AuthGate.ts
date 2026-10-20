import { defineComponent } from 'vue'
import type { PropType, SlotsType, VNodeChild } from 'vue'
import type { Whoami } from '../client/identity.js'
import { useWhoami } from './useWhoami.js'
import type { UseWhoamiOptions } from './useWhoami.js'

export interface AuthGateSlotContext {
  whoami: Whoami | null | undefined
  loading: boolean
  error: Error | null
  refetch: () => Promise<void>
  signOut: () => Promise<void>
}

export interface AuthGateSlots {
  default?: (context: AuthGateSlotContext & { whoami: Whoami }) => VNodeChild
  unauthenticated?: (context: AuthGateSlotContext) => VNodeChild
  loading?: (context: AuthGateSlotContext) => VNodeChild
  error?: (context: AuthGateSlotContext & { error: Error }) => VNodeChild
}

/** Identity presentation only. Authorization remains the server's responsibility. */
export const AuthGate = defineComponent({
  name: 'AuthGate',
  slots: Object as SlotsType<AuthGateSlots>,
  props: {
    options: { type: Object as PropType<UseWhoamiOptions>, default: () => ({}) },
  },
  setup(props, { slots }) {
    // Options are setup-time configuration; remount to change clients/endpoints.
    const auth = useWhoami({ exchange: {}, ...props.options })
    return () => {
      const context = { whoami: auth.whoami.value, loading: auth.loading.value, error: auth.error.value, refetch: auth.refetch, signOut: auth.signOut }
      if (context.loading) return slots.loading?.(context)
      // Without an error slot, the wall receives the error and retry action.
      if (context.error) return slots.error ? slots.error({ ...context, error: context.error }) : slots.unauthenticated?.(context)
      if (context.whoami == null) return slots.unauthenticated?.(context)
      return slots.default?.({ ...context, whoami: context.whoami })
    }
  },
})
