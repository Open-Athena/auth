import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('the client runtime module graph has no framework or external dependencies', () => {
  const visited = new Set<string>()
  const external = new Set<string>()
  const frameworks = new Set<string>()
  function visit(path: string): void {
    if (visited.has(path)) return
    visited.add(path)
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const statement of file.statements) {
      let specifier: ts.Expression | undefined
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause
        if (clause?.isTypeOnly) continue
        if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.every(element => element.isTypeOnly)) continue
        specifier = statement.moduleSpecifier
      } else if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)
          && statement.exportClause.elements.every(element => element.isTypeOnly)) continue
        specifier = statement.moduleSpecifier
      }
      if (!specifier || !ts.isStringLiteral(specifier)) continue
      const name = specifier.text
      if (!name.startsWith('.')) { external.add(name); continue }
      const target = resolve(dirname(path), name.replace(/\.js$/, '.ts'))
      if (target.includes('/src/react/')) frameworks.add(target)
      if (!existsSync(target)) throw new Error(`Unresolved client import: ${target}`)
      visit(target)
    }
  }
  visit(resolve('src/client/index.ts'))
  expect([...external].sort()).toEqual([])
  expect([...frameworks].sort()).toEqual([])
})
