import { AuthGate, ProfilePanel, type Whoami } from '@open-athena/auth/react'
import { VIEW_SOURCE } from '../api.js'
import { Link, useNavigate } from '../router.js'
import { SignIn } from '../SignIn.js'

/** Self-serve name and face, opened from the nav chip. Only an email session owns a profile row. */
export function Profile() {
  const navigate = useNavigate()
  return (
    <div className="prose">
      <h1>Your name and face</h1>
      <AuthGate<Whoami>
        source={VIEW_SOURCE}
        loading={<p className="muted">Checking…</p>}
        signIn={refresh => <SignIn title={null} onSignedIn={refresh} />}
      >
        {whoami =>
          whoami.kind === 'sso' ? (
            <>
              <p className="muted small">
                Whatever you set here is what the chip and the admin table render. An avatar is fetched once
                server-side and stored inline — never hot-linked from a third party on every view.
              </p>
              <ProfilePanel
                endpoint="/api/view/profile"
                whoami={whoami}
                onSaved={() => navigate('/dashboard')}
                classNames={{
                  form: 'stack',
                  field: 'field',
                  input: 'input',
                  select: 'input',
                  button: 'btn primary',
                  message: 'ok small',
                  preview: 'row',
                }}
              />
            </>
          ) : (
            <p className="muted">
              A link session's name belongs to the link, not to you — whoever minted it set it. <Link to="/">Sign in</Link>{' '}
              to have a profile of your own.
            </p>
          )
        }
      </AuthGate>
    </div>
  )
}
