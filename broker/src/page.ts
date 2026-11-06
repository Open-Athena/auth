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
main.wide { max-width: 60rem; width: calc(100% - 2rem); box-sizing: border-box; padding: 1.25rem }
h2 { font-size: 1.05rem; margin: 1.75rem 0 0.5rem }
label { display: block; margin: 0.75rem 0 0.25rem; font-size: 0.9rem; color: var(--muted) }
input:not([type=checkbox]), textarea { box-sizing: border-box; width: 100% }
textarea { font: 0.9rem ui-monospace, monospace; padding: 0.4rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg) }
label.check { display: inline-flex; gap: 0.4rem; align-items: center; margin: 0 }
button.quiet { background: none; color: var(--fg) }
code { font: 0.9em ui-monospace, monospace; overflow-wrap: anywhere }
.error { border: 1px solid #dc2626; color: #dc2626; border-radius: 8px; padding: 0.5rem 0.75rem; margin: 0.75rem 0 }
.client { border-top: 1px solid var(--border); padding: 0.75rem 0 }
.client h3 { font-size: 1rem; margin: 0; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: baseline }
.tag { font-size: 0.75rem; border: 1px solid var(--border); border-radius: 999px; padding: 0 0.5rem; color: var(--muted) }
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
