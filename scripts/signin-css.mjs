#!/usr/bin/env node
// The "Sign in with OA" button's styles, from their one source (`OA_SIGNIN_CSS`): `dist/signin/signin.css`, and
// appended to `dist/react/ui.css`.
import { appendFileSync, writeFileSync } from 'node:fs'

const { OA_SIGNIN_CSS } = await import(new URL('../dist/signin/index.js', import.meta.url).href)
writeFileSync(new URL('../dist/signin/signin.css', import.meta.url), OA_SIGNIN_CSS)
appendFileSync(new URL('../dist/react/ui.css', import.meta.url), `\n${OA_SIGNIN_CSS}`)
