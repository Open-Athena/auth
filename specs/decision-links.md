# Decision links: approve/deny an access request from the notification

## Problem

The review-gated flow already works end to end in code — `requestAccess` queues a
pending row, `approveRequest` mints a grant and mails the link, `denyRequest`
records the refusal. What's missing is the admin's half: today deciding requires
opening the app, authenticating, and finding the queue. For a flow whose whole
value is "someone is blocked, unblock them quickly", that's the step that makes
requests sit for a day.

The goal: the `access-requested` notification carries **Approve** and **Deny**
buttons that work from the mail client, with no session and no app visit.

## Threat model

The decision URL is a bearer credential. Anyone holding it can decide the
request. That is intentional — the notification goes to an admin group, and any
member should be able to act without us knowing who they are in advance.

What the design must still prevent:

1. **Verb tampering.** A holder of the *deny* URL must not be able to edit it
   into an *approve*. Cheap to prevent, so prevent it.
2. **Cross-request replay.** A token for request A must be useless on request B.
3. **Automated clicking.** See below — this is the failure mode most likely to
   be missed, and it silently grants access.
4. **Unbounded validity.** A decision link in a mail archive should not still
   work a year later.

Explicitly *not* prevented: a person forwarding the notification to someone who
then decides. The mail is the credential; protecting it is the operator's job,
which is why the default `MAIL_ADMIN_TO` is a group they control.

## The pitfall that drives the route shape: mail scanners click links

Outlook Safe Links, corporate mail gateways, and antivirus scanners **fetch every
URL in an incoming message** to check it. If `GET /decide?t=…&verb=approve`
commits the decision, a meaningful share of requests will be auto-approved
before a human reads the mail — and it will look like the admin did it.

So the decision is split across two requests, which is the standard HTTP
contract anyway:

- `GET /decide?t=<token>` — **safe and idempotent**. Renders a confirmation page
  showing who asked, what they said, and two buttons. Commits nothing.
- `POST /decide` (form body `t=<token>`) — commits.

Scanners issue GETs, not form POSTs, so the confirmation page absorbs them.

## Token shape

Reuses `signSession`, the same HMAC-signed, TTL'd, storage-free primitive behind
sessions and the OIDC `state`:

```
sub = `decide:${verb}:${requestId}`     verb ∈ 'approve' | 'deny'
```

- The verb is **inside the signature**, so #1 is structural rather than checked.
- The request id is inside it, so #2 is too.
- `exp` handles #4. Default TTL **7 days**, config `decisionLinks.ttlS`.
- Two tokens per notification, one per verb.
- No storage: nothing to clean up, and the request row is the only state.

Verification failure (forged, expired, malformed, wrong request) renders one
generic "this link is no longer valid" page. Distinguishing *expired* from
*forged* tells a prober which of the two they achieved.

## Idempotence and reversal

`AccessRequest` already carries `status`, `decidedAt`, `decidedBy`, `grantId`, so
"what happened already" is a read, not new state.

Re-clicking the **same verb** is a no-op that renders the outcome — never an
error. An admin who clicks twice, or two admins who both approve, should see
"already approved", not a failure.

For the **opposite verb**, three configurable modes (`decisionLinks.reversal`):

| mode | behaviour |
|---|---|
| `first-wins` *(default)* | The first decision is final; the opposite verb renders the outcome and changes nothing. `reversalWindowS` is unused. |
| `deny-wins` | A deny within `reversalWindowS` overrides an earlier approve. An approve never overrides a deny. |
| `last-wins` | Either verb overrides the other, within the window. |

Default is `first-wins`: one rule, no clock. A misclick is not unrecoverable
under it, just fixed elsewhere — an accidental approve by revoking the grant in
the admin UI, an accidental deny by approving the re-request. That beats a
second, time-dependent rule that only helps whoever clicks twice within the
hour. `reversalWindowS` defaults to 1 hour for the modes that consult it.

**A reversal must revoke, not just relabel.** By the time a deny lands, the
approve has already mailed a working magic link. `request.grantId` records which
grant was minted, so reversing calls `revoke(grantId)` — killing live sessions on
their next request, which is exactly the property `revoke` exists for. A mode
that flipped `status` and left the grant usable would be worse than not offering
reversal at all.

## Attribution

Two modes, and the unauthenticated one must be honest rather than invent a name.

- **`requireAuth: false`** *(default)* — anyone holding the link decides;
  `decidedBy` is recorded as `'email-link'`. The outcome page reads "already
  approved via email link at $ts". We do not have a name, so we do not print one.
- **`requireAuth: true`** — the endpoint authenticates first and requires an
  admin scope. An unauthenticated click redirects to sign-in and returns.
  `decidedBy` is the authenticated email, and the page reads "already approved by
  ada@openathena.ai at $ts".

## Rendering

This endpoint is reached from a mail client, outside the SPA, so the library must
ship real HTML rather than JSON. It ships a minimal self-contained page — no
external assets, works in both colour schemes — and an escape hatch:

```ts
decisionLinks: {
  render?: (state: DecisionView) => Response   // override wholesale
  appName?: string
}
```

`DecisionView` is a discriminated union over `confirm | decided | already | invalid`,
so an app can restyle without re-deriving the logic.

## Config surface

Everything below has a default except where marked. The whole feature is off
until `decisionLinks` is present.

```ts
createGate({
  decisionLinks: {
    ttlS: 7 * 86400,               // link validity
    reversal: 'first-wins',        // | 'deny-wins' | 'last-wins'
    reversalWindowS: 3600,
    requireAuth: false,
    appName: 'this site',
    render: undefined,
  },
})
```

And in `emailNotify`, one required function — the app owns its URL space:

```ts
emailNotify({
  decideUrlFor: token => `https://app.example/decide?t=${token}`,   // required iff decision links are on
})
```

## Wiring

1. `requestAccess`, when `decisionLinks` is configured and the outcome is
   `pending`, mints both tokens and attaches them to the event:
   `{ kind: 'access-requested', request, decision: { approve, deny } }`.
2. `emailNotify` renders the two buttons when the event carries `decision` and
   `decideUrlFor` is set. Text part gets both URLs on their own lines — the token
   is already a bearer credential in the body, which is the same exposure the
   magic-link mail has and is acceptable for the same reason.
3. `gate.decide(token, { nowMs, actor })` — the whole state machine, returning a
   `DecisionView`. Deliberately a plain function so a Slack action handler is a
   thin caller rather than a second implementation.
4. `POST /requests/decide` and `GET /requests/decide` in `routes.ts`.

## Acceptance

- [ ] A GET never mutates; a scanner fetching every URL in the mail decides nothing.
- [ ] Approve URL edited to `deny` (and vice versa) fails signature verification.
- [ ] A token for request A rejected on request B.
- [ ] Expired token → the same page as a forged one.
- [ ] Same verb twice → "already", no second grant, no second mail.
- [ ] `first-wins` (default): neither verb reverses, and no window is consulted.
- [ ] `deny-wins`: deny after approve revokes the minted grant; a live session
      dies on its next request.
- [ ] `deny-wins`: approve after deny changes nothing.
- [ ] `last-wins` behaves as tabulated.
- [ ] Outside `reversalWindowS`, no mode reverses.
- [ ] `requireAuth: true` rejects an unauthenticated POST.
- [ ] `decidedBy` is `'email-link'`, never a fabricated identity.

## Deliberately out of scope

- **Slack interactivity.** Needs a public endpoint, signature verification, app
  registration and per-workspace install state — an integration, not a function.
  `gate.decide` is the seam: a Slack handler should be ~20 lines in the app.
- **Persistent allowlisting on approve** ("add them going forward, let them use
  SSO next time"). Wants a policy store that outlives a single grant. Real, and
  next; not this change.
