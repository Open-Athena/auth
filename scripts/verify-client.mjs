#!/usr/bin/env node
import { deepEqual, equal } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const entry = resolve(root, 'dist/client/index.js')
const visited = new Set()
const externals = new Set()
function visit(path) {
  if (visited.has(path)) return
  visited.add(path)
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const add = name => {
    if (!name.startsWith('.')) { externals.add(name); return }
    visit(resolve(dirname(path), name))
  }
  function inspect(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      add(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(file) === 'require')) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new Error('Uninspectable client import')
      add(node.arguments[0].text)
    }
    ts.forEachChild(node, inspect)
  }
  inspect(file)
}
visit(entry)
deepEqual([...externals].sort(), [])
const clientModules = visited.size

// The session-log boot shim: no dependencies either, and its lazily imported
// logger is reachable (the dynamic `import()` is followed like any other).
const slogEntry = resolve(root, 'dist/client/session-log/index.js')
visited.clear()
visit(slogEntry)
deepEqual([...externals].sort(), [])
equal(visited.has(resolve(root, 'dist/client/session-log/logger.js')), true)
const slog = await import(pathToFileURL(slogEntry).href)
equal(typeof slog.bootSessionLog, 'function')
equal(typeof slog.slog, 'function')
const { createAuthClient, shareUrl, exchangeKeyParam, downscaleImage } = await import(pathToFileURL(entry).href)
equal(typeof createAuthClient, 'function')
equal(typeof exchangeKeyParam, 'function')
equal(typeof downscaleImage, 'function')
equal(shareUrl('test-token', 'https://app.test/slides/3?theme=dark#notes'), 'https://app.test/slides/3?theme=dark&key=test-token#notes')
console.log(`client artifact: ${clientModules} modules (session log: ${visited.size}), no external dependencies, SSR import and share URL verified`)
