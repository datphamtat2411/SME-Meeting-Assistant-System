import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

const languages = ['en', 'vi']

function readCatalog(language) {
  const directory = join('src/lib/i18n/locales', language)
  return Object.fromEntries(
    readdirSync(directory)
      .filter((file) => file.endsWith('.json'))
      .map((file) => [
        file.slice(0, -5),
        JSON.parse(readFileSync(join(directory, file), 'utf8')),
      ])
  )
}

const catalogs = languages.map(readCatalog)

function hasTranslation(catalog, key) {
  const [namespace, resourceKey] = key.includes(':')
    ? key.split(':', 2)
    : ['common', key]
  const parts = resourceKey.split('.')
  const leaf = parts.pop()
  const parent = parts.reduce(
    (value, segment) => value?.[segment],
    catalog[namespace]
  )
  return (
    typeof parent?.[leaf] === 'string' ||
    typeof parent?.[leaf + '_other'] === 'string'
  )
}

test('literal UI translation references resolve in both catalogs', () => {
  const missing = []
  const files = readdirSync('src', { recursive: true }).filter(
    (file) =>
      /\.tsx?$/.test(file) && !/\.(test|spec|gen|d)\.tsx?$/.test(file)
  )

  for (const file of files) {
    const path = join('src', file)
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const usesUiTranslation = source.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        /(?:^|\/)i18n(?:\/index)?$/.test(statement.moduleSpecifier.text)
    )

    function check(key, node) {
      if (!catalogs.every((catalog) => hasTranslation(catalog, key))) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart())
        missing.push(`${path}:${line + 1}: ${key}`)
      }
    }

    function visit(node) {
      if (usesUiTranslation && ts.isCallExpression(node)) {
        const callee = node.expression
        const argument = node.arguments[0]
        const isTranslation =
          (ts.isIdentifier(callee) && callee.text === 't') ||
          (ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === 'i18n' &&
            callee.name.text === 't')
        if (isTranslation && argument && ts.isStringLiteralLike(argument)) {
          check(argument.text, argument)
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'featureValidationMessage' &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        check(node.arguments[0].text, node.arguments[0])
      }
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'titleKey' &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        check(node.initializer.text, node.initializer)
      }
      // Feature-owned mapping tables can contain keys outside a t() call.
      if (
        usesUiTranslation &&
        ts.isStringLiteralLike(node) &&
        /^[\w-]+:[\w.-]+$/.test(node.text) &&
        Object.hasOwn(catalogs[0], node.text.split(':')[0]) &&
        !node.text.endsWith('_')
      ) {
        check(node.text, node)
      }
      // The centralized presentation module also returns literal keys.
      if (
        file === join('lib', 'i18n', 'presentation.ts') &&
        ts.isStringLiteralLike(node) &&
        node.text.startsWith('errors:')
      ) {
        check(node.text, node)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  assert.deepEqual(missing, [], 'Missing UI translation keys')
})

test('known dynamic status and source keys resolve without fallback', () => {
  const groups = [
    ['status:meeting.', ['DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'ENDED', 'CANCELLED']],
    ['status:role.', ['EMPLOYEE', 'DEPARTMENT_MANAGER', 'ADMINISTRATOR']],
    ['status:account.', ['ACTIVE', 'INACTIVE', 'PENDING_SETUP']],
    ['action-items:status_', ['PROPOSED', 'OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']],
    ['decisions:value_', ['PROPOSED', 'CONFIRMED', 'REJECTED', 'AI_EXTRACTED', 'MANUAL', 'HUMAN_CREATED']],
    ['transcript:status_', ['READY', 'READY_WITH_WARNINGS', 'FAILED', 'HIGH', 'ACCEPTED', 'SUSPICIOUS', 'UNRESOLVED_ERROR']],
    ['transcript:reviewGate_status_', ['READY', 'READY_WITH_WARNINGS', 'FAILED', 'PROCESSING']],
    ['summary:status_', ['AI_GENERATED', 'HUMAN_EDIT', 'READY', 'READY_WITH_WARNINGS', 'FAILED']],
    ['export:status_', ['PENDING', 'GENERATING', 'READY', 'FAILED']],
  ]
  for (const [prefix, values] of groups) {
    for (const value of values) {
      const key = prefix + value
      for (const [index, catalog] of catalogs.entries()) {
        assert.ok(hasTranslation(catalog, key), `${languages[index]}: ${key}`)
      }
    }
  }
})

test('static document metadata matches the Vietnamese startup default', () => {
  const html = readFileSync('index.html', 'utf8')
  assert.match(html, /<html lang="vi">/)
})
