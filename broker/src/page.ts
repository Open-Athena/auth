/** The broker's server-rendered pages. */
export const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

export function page(title: string, body: string, status = 200, { headers = {}, wide = false }: { headers?: Record<string, string>; wide?: boolean } = {}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · OA sign-in</title>
<style>
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafafa; --muted: #666; --accent: #2563eb; --card: #fff; --border: #ddd }
@media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #121212; --muted: #999; --accent: #60a5fa; --card: #1e1e1e; --border: #333 } }
body { font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0; display: grid; grid-template-columns: minmax(0, 1fr); place-items: center; min-height: 100vh }
main { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 2rem; max-width: 26rem; margin: 1rem }
h1 { font-size: 1.25rem; margin: 0 0 1rem }
p { margin: 0.5rem 0 }
.muted { color: var(--muted) }
a, button.link { color: var(--accent) }
.actions { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 1.25rem; align-items: center }
.button, button { font: inherit; padding: 0.5rem 1rem; border-radius: 8px; border: 1px solid var(--border); background: var(--accent); color: #fff; text-decoration: none; cursor: pointer }
button.link { background: none; border: none; padding: 0; text-decoration: underline }
input { font: inherit; padding: 0.4rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg) }
main.wide { max-width: 82rem; width: calc(100% - 2rem); box-sizing: border-box; padding: 1.25rem; border: 0; border-radius: 0; background: none; align-self: start }
h2 { font-size: 1.05rem; margin: 1.75rem 0 0.5rem }
label { display: block; margin: 0.75rem 0 0.25rem; font-size: 0.9rem; color: var(--muted) }
input:not([type=checkbox]), textarea { box-sizing: border-box; width: 100% }
textarea { font: 0.9rem ui-monospace, monospace; padding: 0.4rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg) }
label.check { display: inline-flex; gap: 0.4rem; align-items: center; margin: 0 }
button.quiet { background: none; color: var(--fg) }
code { font: 0.9em ui-monospace, monospace; overflow-wrap: anywhere }
.error { border: 1px solid #dc2626; color: #dc2626; border-radius: 8px; padding: 0.5rem 0.75rem; margin: 0.75rem 0 }
.apps { table-layout: fixed; min-width: 42rem; white-space: normal; margin-top: 1.25rem }
.apps th:nth-child(1) { width: 23% }
.apps th:nth-child(2) { width: 42% }
.apps th:nth-child(3) { width: 12% }
.apps th:nth-child(4) { width: 23% }
.apps td, .apps th { padding: 0.8rem 0.75rem; vertical-align: middle }
.apps thead th { color: var(--muted); font-weight: 500; font-size: 0.8rem }
.app-name, .app-id { display: block; overflow-wrap: anywhere }
.app-name { font-size: 0.95rem; font-weight: 600 }
.app-id { margin-top: 0.2rem; font-weight: 400 }
.callbacks code { white-space: normal; overflow-wrap: anywhere }
.row-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin: 0 }
.row-actions form { margin: 0 }
.row-actions button { padding: 0.35rem 0.7rem; font-size: 0.85rem }
.status { color: var(--muted); font-size: 0.8rem; white-space: nowrap }
.status.active { color: #278348 }
.status.disabled { color: #b06a21 }
.app-editor td { background: var(--card); padding: 1rem 1.25rem 1.25rem }
.app-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.75rem 1.25rem; align-items: start; max-width: 62rem }
.app-fields label { margin: 0 }
.app-fields label:first-child { grid-column: 1 / -1 }
.app-fields .actions { grid-column: 1 / -1; margin-top: 0 }
.create-app label:first-child { grid-column: auto }
.secret-actions { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; margin-top: 1.25rem; border-top: 1px solid var(--border); padding-top: 1rem; font-size: 0.8rem }
.create-app { margin-top: 0.75rem }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px }
@media (prefers-color-scheme: dark) { .status.active { color: #8bd6a4 } .status.disabled { color: #edba7c } }
@media (max-width: 40rem) { main.wide { padding: 0.5rem; margin: 1rem 0.5rem; width: calc(100% - 1rem) } .app-fields { grid-template-columns: minmax(0, 1fr) } .app-fields label { grid-column: 1 } }
.scroll { overflow-x: auto }
table { border-collapse: collapse; font-size: 0.85rem; width: 100%; white-space: nowrap }
td code { overflow-wrap: normal }
td, th { text-align: left; padding: 0.25rem 0.75rem 0.25rem 0; vertical-align: top; border-bottom: 1px solid var(--border) }
</style>
</head>
<body><main${wide ? ' class="wide"' : ''}><h1>${esc(title)}</h1>
${body}
</main></body>
</html>
`
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } })
}

export const redirect = (to: string, cookies: string[] = []) => {
  const headers = new Headers({ location: to, 'cache-control': 'no-store' })
  for (const c of cookies) headers.append('set-cookie', c)
  return new Response(null, { status: 302, headers })
}
