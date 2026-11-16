# Grant cards: a clipboard icon per scope row, no "Show links" panel

From `jobs` (2026-11-16, dist `3516375`). Ryan, on a kept-key card after "Show links": "this is very cluttered. show a clipboard icon next to each JD, no toggle, no link or "Copy" button".

## Today

A kept grant's card shows a "Show links" button. Clicking it fetches the key (`GET /grants/:id/token`, logged) and opens a `GrantLink` panel:

- each scope row grows a text box with the URL and a "Copy" button;
- below them, a box with the kept-key note, the non-scope entries ("All of them" + text box + "Copy"), and "Copy key", "Copy all" and "Done".

On a card with 5 checked scopes that is 6 text boxes and 9 buttons, and the scope list no longer lines up.

## Ask

When the card can produce links (the key is kept, or a just-minted or rotated token is in memory):

- **Each scope row with a link entry gets one small clipboard icon button** after its label: no text box, no "Copy" text, no toggle to reveal it.
  - Clicking it copies that row's URL.
  - The icon swaps to a check for ~1.5s; on failure, a short error.
  - A tooltip says "Copy link" (the app can relabel it through `labels`). Use the library's tooltip if it has one, not `title`.
- **Non-scope entries and the key go on one compact line under the scopes**, as label + icon pairs. For `jobs`: "All of them [icon] · key [icon] · all [icon]", where the last is "Copy all".
  - `keyParam` (the `?k=` suffix) is still what the key icon copies.
- **No "Show links" button, no panel, no "Done".**
  - The muted note "Its key is kept, sealed; each copy is logged." and "forget key" stay.
- **Fetching a kept key:**
  - Fetch on the first click, not when the card renders, so each fetch is still a logged look.
  - Then hold the key in memory for the card's lifetime, so further copies don't refetch.
  - The clipboard write must survive Safari's user-gesture rule across the `await`. Use `navigator.clipboard.write([new ClipboardItem({ 'text/plain': promiseOfBlob })])`, falling back to `writeText`.
- **A just-minted or rotated key that isn't kept** ("Forget the key after this") shows the same icons.
  - Add a one-line warning that it's shown only once (the existing `warning` label).
  - Keep the icons until the card is reloaded or the user dismisses them (a small "×" on the warning line). Today's "Done" does that.
- **A card whose key isn't kept and isn't in memory** looks as it does today: no icons, the "keep this link's key" affordance.
- **The mint form's result** (`GrantsPanel` right after minting) follows the same pattern: the new card shows icons, not the panel.

## Swappable pieces

Ryan: auth "should provide the default i described, but also hooks for arbitrary components to be subbed in for different styling/behavior". The icons above are the default. `GrantCard` and `GrantsPanel` take a `components` prop (passed through from the panel to each card), and each slot falls back to the built-in:

```ts
interface GrantLinkComponents {
  /** One copy control: a scope row's, a non-scope entry's, the key's, or "all"'s. */
  Copy?: ComponentType<CopyProps>
  /** What sits after a scope's label: by default `<Copy>` when the card has a link for that scope. */
  ScopeLink?: ComponentType<ScopeLinkProps>
  /** The line under the scopes: non-scope entries, the key and "all". */
  ExtraLinks?: ComponentType<ExtraLinksProps>
}

interface CopyProps {
  kind: 'scope' | 'entry' | 'key' | 'all'
  label: string
  /** Resolves the text to copy. It fetches the kept key on first use, which is logged. Call it from the click handler, so the clipboard write keeps the user gesture. */
  text: () => Promise<string>
  /** Copy `text()` the library's way (ClipboardItem with a promise, falling back to `writeText`) and report how it went. */
  copy: () => Promise<'copied' | 'failed'>
}

interface ScopeLinkProps {
  grant: Grant
  scope: string
  entry: GrantLinkEntry
  Copy: ComponentType<CopyProps>
  copyProps: CopyProps
}

interface ExtraLinksProps {
  grant: Grant
  entries: readonly GrantLinkEntry[]
  Copy: ComponentType<CopyProps>
  /** Ready-made props for each control, in display order: entries, then key, then all. */
  copies: readonly CopyProps[]
  /** Set only while a just-minted key that isn't kept is on screen: hides the icons. */
  onDismiss?: () => void
}
```

- The slots get behavior (`text`/`copy`, the lazy fetch, the once-only warning state) from the card, so a replacement only changes how things look and what a click does. It never reimplements fetching or logging.
- Export the defaults (`CopyIcon`, `DefaultScopeLink`, `DefaultExtraLinks`), so an app can wrap one instead of rewriting it.
- `GrantLink` (today's expanded panel) stays exported. An app that wants it can render it from an `ExtraLinks` replacement, given `text()` for the token.
- `labels` and `classNames` keep working for small changes. `components` is for anything structural.

## What `jobs` will do after this lands

Bump the dist. No code change expected: `buildLink` already returns one entry per JD with `scope`, plus "All of them".
