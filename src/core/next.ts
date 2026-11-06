const ORIGIN = 'https://same-origin.invalid'

/**
 * A `?next=` made safe to redirect to: a path on this origin, in the form a
 * browser would read it, or `fallback`. Parsed the way a browser parses a
 * `Location`, because prefix checks miss what it normalizes: `\` reads as `/` and
 * tabs and newlines are dropped, so `/\evil.test` and `/<tab>/evil.test` are both
 * `//evil.test`. The result is re-checked, since `/x/..//evil.test` only becomes
 * `//evil.test` once its dot segments are resolved.
 */
export function safeNext<F extends string | null>(raw: string | null | undefined, fallback: F): string | F {
  if (!raw?.startsWith('/')) return fallback
  try {
    const url = new URL(raw, ORIGIN)
    if (url.origin !== ORIGIN || url.pathname.startsWith('//')) return fallback
    return url.pathname + url.search + url.hash
  } catch {
    return fallback
  }
}
