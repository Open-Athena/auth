import { useNavigate } from '../router.js'
import { SignIn } from '../SignIn.js'

/**
 * Sign in as another address without signing out: the dashboard's gate keeps
 * both, and the nav's Accounts menu switches between them. Google's own
 * account chooser and this list are separate things: adding an account still
 * takes a real Google sign-in or emailed code.
 */
export function AddAccount() {
  const navigate = useNavigate()
  return (
    <div className="wall">
      <SignIn title="Add an account" onSignedIn={() => navigate('/dashboard')} />
      <p className="muted small">
        The account you're signed in as stays: switch back from <strong>Accounts</strong> in the top bar.
      </p>
    </div>
  )
}
