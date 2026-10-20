import { createApp, defineComponent, h } from 'vue'
import { AuthGate, type UseWhoamiResult } from '@open-athena/auth/vue'
import type { Whoami } from '@open-athena/auth/client'
import { endpoint, exchange, identityLabel, linkFor, mountShell, trackView } from './shell.js'

const host = mountShell('Vue · @open-athena/auth/vue')
interface GateContext {
  whoami: Whoami | null | undefined
  signOut: UseWhoamiResult['signOut']
  refetch: UseWhoamiResult['refetch']
}

function identity({ whoami, signOut }: GateContext) {
  if (!whoami) return []
  return [
    h('h2', "You're in."),
    h('p', { class: 'example-identity' }, [
      ...(whoami.subject?.avatar ? [h('img', { src: whoami.subject.avatar, alt: '', width: 40, height: 40, referrerpolicy: 'no-referrer', onError: (event: Event) => (event.target as HTMLImageElement).hidden = true })] : []),
      identityLabel(whoami),
    ]),
    h('code', whoami.kind === 'grant' ? `g:${whoami.id}` : `e:${whoami.email}`),
    h('div', { class: 'placeholder' }, 'Your private workspace'),
    h('button', { class: 'btn', onClick: () => void signOut().catch(() => {}) }, 'Sign out'),
  ]
}

const Example = defineComponent({
  setup() {
    return () => h(AuthGate, { options: { basePath: endpoint, exchange } }, {
      loading: () => h('p', 'Checking access…'),
      error: (context: GateContext) => [
        ...identity(context),
        h('p', { role: 'alert' }, context.whoami ? 'Could not sign out. Please try again.' : 'Could not check access. Please try again.'),
        ...(!context.whoami ? [h('button', { class: 'btn', onClick: context.refetch }, 'Try again')] : []),
      ],
      unauthenticated: () => [
        h('h2', 'Private workspace'),
        h('p', { class: 'muted' }, 'Open a demo link to enter. No account needed.'),
        h('div', { class: 'wall-actions' }, [
          h('a', { href: linkFor(true), class: 'btn primary' }, 'Open named link'),
          h('a', { href: linkFor(false), class: 'btn' }, 'Open anonymous link'),
        ]),
      ],
      default: identity,
    })
  },
})

createApp(Example).mount(host)
trackView()
