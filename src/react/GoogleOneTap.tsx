import { type ReactNode, useEffect, useRef, useState } from 'react'

/** The slice of Google Identity Services we touch. */
interface GsiId {
  initialize(config: Record<string, unknown>): void
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void
  prompt(): void
  cancel(): void
}
interface GsiCredentialResponse {
  credential: string
}

const GSI_SRC = 'https://accounts.google.com/gsi/client'

export interface GoogleOneTapProps {
  /** The public OAuth client id. Safe in the page by design. */
  clientId: string
  /** `GET` → `{ nonce }`. Default `/api/auth/google/onetap/nonce`. */
  nonceEndpoint?: string
  /** `POST {credential, nonce}`. Default `/api/auth/google/onetap`. */
  verifyEndpoint?: string
  /** Called after a credential verifies — refetch `useWhoami`. */
  onSignedIn?: () => void
  /** Verified but not on the allowlist: the Google-verified email, for request-access pre-fill. */
  onDenied?: (email: string) => void
  /** Options forwarded to `renderButton` (theme, size, text, shape, width). */
  buttonOptions?: Record<string, unknown>
  className?: string
  /**
   * Also surface Google's One Tap prompt (the corner toast) on mount, not just
   * the button. Off by default: it's an overlay the visitor didn't ask for. Worth
   * it where nearly everyone signs in with Google (an internal dashboard).
   * `autoSelect` signs a returning visitor in with no click at all when exactly
   * one of their Google accounts has already granted *this* client.
   */
  prompt?: boolean | { autoSelect?: boolean }
  /** Rendered when GSI can't load (SSR, offline, blocked, unsupported). The Ask 3 redirect button belongs here. */
  fallback?: ReactNode
  /** Overridable for tests. Default the real GSI URL. */
  scriptSrc?: string
}

/** Load a script once; resolve when ready, reject if it errors. Shared across mounts. */
function loadScript(src: string): Promise<void> {
  if (typeof document === 'undefined') return Promise.reject(new Error('no document'))
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)
  if (existing) {
    if (existing.dataset.loaded === 'true') return Promise.resolve()
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('script error')))
    })
  }
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = src
    el.async = true
    el.addEventListener('load', () => {
      el.dataset.loaded = 'true'
      resolve()
    })
    el.addEventListener('error', () => reject(new Error('script error')))
    document.head.appendChild(el)
  })
}

/**
 * Google One Tap, **button-first**: a rendered "Sign in with Google" button. The
 * auto-surfacing prompt is opt-in (`prompt`), since it's an overlay the visitor
 * didn't ask for. It's the in-page, no-redirect variant of the redirect button,
 * and it degrades to `fallback` whenever GSI can't run — so a page always has a
 * working sign-in, and this is pure upgrade.
 *
 * Both the button and the prompt use FedCM where the browser has it (Chrome's own
 * account UI in the page, rather than a popup window). Google issues a credential
 * without showing its account chooser only once the account has granted *this*
 * client (a redirect sign-in doesn't count), and only with FedCM or third-party
 * cookies.
 *
 * The nonce is minted server-side (`googleOneTapNonce`) and echoed back with the
 * credential, so the POST is replay-bound without any client-trusted state.
 */
export function GoogleOneTap({
  clientId,
  nonceEndpoint = '/api/auth/google/onetap/nonce',
  verifyEndpoint = '/api/auth/google/onetap',
  onSignedIn,
  onDenied,
  buttonOptions = { theme: 'outline', size: 'large', text: 'continue_with' },
  className,
  prompt = false,
  fallback = null,
  scriptSrc = GSI_SRC,
}: GoogleOneTapProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false
    let prompted: GsiId | null = null

    async function init() {
      try {
        const res = await fetch(nonceEndpoint, { credentials: 'include', headers: { accept: 'application/json' } })
        const { nonce } = (await res.json()) as { nonce?: string }
        if (!nonce) throw new Error('no nonce')
        await loadScript(scriptSrc)
        const gsi = (window as unknown as { google?: { accounts?: { id?: GsiId } } }).google?.accounts?.id
        if (cancelled || !gsi || !ref.current) throw new Error('gsi unavailable')

        gsi.initialize({
          client_id: clientId,
          nonce,
          use_fedcm_for_prompt: true,
          use_fedcm_for_button: true,
          auto_select: typeof prompt === 'object' && Boolean(prompt.autoSelect),
          callback: async (resp: GsiCredentialResponse) => {
            try {
              const r = await fetch(verifyEndpoint, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ credential: resp.credential, nonce }),
              })
              const parsed = (await r.json().catch(() => ({}))) as { ok?: boolean; denied?: string }
              if (r.ok && parsed.ok) onSignedIn?.()
              else if (r.status === 401 && parsed.denied) onDenied?.(parsed.denied)
            } catch {
              /* leave the fallback in place; the redirect button still works */
            }
          },
        })
        gsi.renderButton(ref.current, buttonOptions)
        if (prompt) {
          gsi.prompt()
          prompted = gsi
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    }
    void init()
    return () => {
      cancelled = true
      // A toast outliving the component would sign someone in to a page that's gone.
      prompted?.cancel()
    }
    // Mount-only: re-initializing GSI on every prop change re-renders the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (failed) return <>{fallback}</>
  return <div ref={ref} className={className} />
}
