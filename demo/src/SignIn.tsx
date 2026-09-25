import { SignInPanel } from '@open-athena/auth/react'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api } from './api.js'

const FORM = { form: 'stack', field: 'field', input: 'input', button: 'btn', message: 'hint', back: 'btn small' }

/**
 * The composed sign-in every gated page here shows — the library's own
 * `SignInPanel`, wired the way an adopter would wire it: Google (its in-page
 * button, degrading to the redirect when GSI can't load) and an emailed code for
 * everyone else. All three end in the same `gate.signIn`, so the
 * dashboard can't tell them apart, which is the point.
 */
export function SignIn({ onSignedIn, title }: { onSignedIn: () => void; title?: ReactNode }) {
  const google = useQuery({ queryKey: ['google-client'], queryFn: api.googleClient, staleTime: Infinity })
  const clientId = google.data?.clientId ?? null

  return (
    <div className="signin">
      {!clientId && google.isSuccess && (
        <p className="muted small inert">
          No Google client id is configured on this deployment, so there's no One Tap and no{' '}
          <em>Continue with Google</em> — the panel drops a sign-in it can't complete, as any deployment should.
          Google offers no API to create the client; <code>scripts/provision-oauth-client.mjs</code> walks the one
          manual step.
        </p>
      )}
      <SignInPanel
        title={title}
        googleUrl={clientId ? '/auth/google/start?next=%2Fdashboard' : undefined}
        oneTap={
          clientId
            ? { clientId, nonceEndpoint: '/auth/google/onetap/nonce', verifyEndpoint: '/auth/google/onetap', className: 'onetap' }
            : undefined
        }
        onSignedIn={onSignedIn}
        withNext={false}
        emailAuth={{
          startEndpoint: '/auth/email/start',
          verifyEndpoint: '/auth/email/code',
          onSignedIn,
          classNames: FORM,
          labels: { email: 'Or use any email address', send: 'Email me a code', code: 'The 6-digit code' },
          sentHint: email => <Outbox email={email} />,
        }}
        classNames={{ root: 'signin-panel', title: 'signin-title', button: 'btn', googleButton: 'btn google', divider: 'divider' }}
      />
    </div>
  )
}

/**
 * What the email mount captured for this browser. Rendered inside the form's
 * hint `<p>`, so spans only.
 */
function Outbox({ email }: { email: string }) {
  // `gcTime: 0`: a second send to the same address must not show the first mail.
  const box = useQuery({ queryKey: ['outbox', email], queryFn: api.outbox, retry: false, staleTime: 0, gcTime: 0 })
  if (box.isPending) return <>Sending…</>
  const b = box.data
  if (!b || b.email !== email.trim().toLowerCase()) {
    return (
      <>
        If <strong>{email}</strong> is allowed in, a code and a link are on their way. The server answers the same way
        either way — on purpose, so this form can't be used to probe who's allowed.
      </>
    )
  }
  if (b.sent) {
    return (
      <>
        Sent to <strong>{email}</strong>. Enter the code below, or open the link in that mail. Nothing is shown here:
        delivery is the verification.
      </>
    )
  }
  if (!b.code || !b.link) {
    return (
      <>
        Nothing was sent to <strong>{email}</strong> — that address is rate-limited (three per fifteen minutes) or not
        admitted. A real deployment wouldn't say which; this demo tells your browser, and only your browser.
      </>
    )
  }
  return (
    <span className="outbox">
      <span>
        This is the mail <strong>{email}</strong> would have received. The demo can't send to that domain, so it shows
        you the message instead — which proves nothing about the address, and is the one dishonest step on this page.
      </span>
      <span className="outbox-mail">
        Code <code className="code">{b.code}</code> · <a href={b.link}>or open the magic link</a>
      </span>
    </span>
  )
}
