import { AccountSwitcher, type Whoami, useWhoami } from '@open-athena/auth/react'
import { useNavigate } from '../router.js'
import { SignIn } from '../SignIn.js'
import { VIEW_SOURCE } from '../api.js'

/** Where the broker (`/oidc/authorize`) asked to come back to, if anywhere: only its own path. */
function brokerNext(): { next: string; prompt: string | null } | null {
  const q = new URLSearchParams(window.location.search)
  const next = q.get('next')
  return next && next.startsWith('/oidc/authorize?') ? { next, prompt: q.get('prompt') } : null
}

/**
 * Sign in as another address without signing out: the dashboard's gate keeps
 * both, and the nav's Accounts menu switches between them. Google's own
 * account chooser and this list are separate things: adding an account still
 * takes a real Google sign-in or emailed code.
 *
 * Also the OIDC broker's sign-in page: `/oidc/authorize` sends people here
 * with `next` (back to itself) and `prompt`. `select_account` shows this
 * browser's accounts to pick from first; anything else asks for a sign-in.
 */
export function AddAccount() {
  const navigate = useNavigate()
  const broker = brokerNext()
  const { whoami } = useWhoami<Whoami>(VIEW_SOURCE)
  const onward = () => (broker ? window.location.assign(broker.next) : navigate('/dashboard'))

  if (broker?.prompt === 'select_account' && whoami?.kind === 'sso') {
    return (
      <div className="wall">
        <h2>Choose an account</h2>
        <p className="muted small">An app asked this broker who you are. Pick the account to continue as, or add one.</p>
        <AccountSwitcher
          basePath="/api/view"
          classNames={{ root: 'accounts', list: 'accounts-list', item: 'account', active: 'on', switch: 'account-switch', remove: 'btn small account-remove', tag: 'tag soft', actions: 'accounts-actions', button: 'btn small' }}
        />
        <p>
          <button type="button" className="btn" onClick={onward}>
            Continue as {whoami.email}
          </button>
        </p>
        <SignIn title="Or add an account" onSignedIn={onward} next={broker.next} />
      </div>
    )
  }

  return (
    <div className="wall">
      <SignIn title={broker ? 'Sign in to continue' : 'Add an account'} onSignedIn={onward} next={broker?.next} />
      <p className="muted small">
        {broker
          ? 'An app is signing you in through this demo’s broker. Sign in once here, and it (and any other app) needs no page next time.'
          : <>The account you're signed in as stays: switch back from <strong>Accounts</strong> in the top bar.</>}
      </p>
    </div>
  )
}
