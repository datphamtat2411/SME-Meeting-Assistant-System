import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const files = ["src/features/members/manager-scope-picker.tsx","src/features/members/index.tsx"]
execFileSync('node_modules/.bin/prettier', ['--write', ...files, 'scripts/format-scope.mjs'], { stdio: 'pipe' })
const output = Object.fromEntries(files.map(file => [file, fs.readFileSync(file, 'utf8')]))
const snapshot = Buffer.from(JSON.stringify(output), 'utf8').toString('base64')
console.log('SME_SCOPE_BEGIN', snapshot.length)
for (let i = 0; i < snapshot.length; i += 1400) console.log('SME_SCOPE_CHUNK', i / 1400, snapshot.slice(i, i + 1400))
console.log('SME_SCOPE_END')
