# `GoogleOneTap`: opt-in auto-surfacing prompt, and FedCM for the button flow

*(From the gcs session, 2026-09-25, after adopting `SignInPanel`'s `oneTap` on gcs.oa.dev at `eeaf4a4`.)*

## What happened on gcs

The button-first One Tap works: on a second visit the wall shows Google's personalized button ("Continue as Ryan · ryan.williams@openathena.ai"). But clicking it opened a popup window with Google's account chooser ("Choose an account · to continue to oa.dev"), so the streamlining Ryan expected — one click, or no click — didn't happen. Two likely reasons, not yet separated:

1. **First use of a new client.** The gcs client in `oa-auth-509611` was created that day, and the earlier sign-in went through the redirect flow, which the button flow doesn't count as a prior grant. Google issues the credential silently only once it holds a grant for that account on that client.
2. **Third-party cookies.** Chrome's restrictions make the button flow fall back to a popup even with a prior grant. Google's answer is FedCM for the button flow: `use_fedcm_for_button: true` in `initialize()`, which lets Chrome (125+) show its own in-page account UI instead of a popup window. The component sets `use_fedcm_for_prompt: true` only.

Ryan will report whether a second click, after that first grant, still opens the chooser.

## Asks

1. **`use_fedcm_for_button: true`** by default in `GoogleOneTap`'s `initialize()`. Chrome then handles the button flow natively where it can; other browsers keep the popup. No API change.
2. **An opt-in auto-surfacing prompt.** Today the component is button-first by design (no overlay a visitor didn't ask for, no display caps), which is the right default. Add `prompt?: boolean | { autoSelect?: boolean }` to `GoogleOneTapProps` (and so to `SignInPanel`'s `oneTap`): when set, after `initialize()` also call `google.accounts.id.prompt()`, with `auto_select` from the option, so a visitor with one signed-in Google account that has used the app before is signed in with no click at all, and everyone else sees the corner toast. The rendered button stays as the always-there fallback. Keep the default off. gcs would turn it on: it's an internal dashboard whose whole audience signs in with Google, so the toast is the point, not an interruption.
3. **Document both** in the component's docstring and the README's One Tap section: what silent issuance needs (a prior grant on *this* client, plus either third-party cookies or FedCM), and why the prompt is opt-in.

## Done when

- gcs can set `oneTap={{ …, prompt: { autoSelect: true } }}` and a returning visitor with one Google account lands signed in without clicking.
- A click on the rendered button in Chrome uses FedCM rather than a popup window.
- The dist branch carries it; gcs bumps its pin and enables `prompt`.
