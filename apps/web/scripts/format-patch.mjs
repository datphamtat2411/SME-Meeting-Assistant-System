import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const files = ["src/features/action-items/action-api.ts","src/features/action-items/action-form.tsx","src/features/action-items/meeting-actions-panel.tsx","src/features/meetings/meeting-tools.tsx"]
execFileSync('node_modules/.bin/prettier', ['--write', ...files, 'scripts/format-patch.mjs'], { stdio: 'pipe' })
const filesByPath = Object.fromEntries(files.map((file) => [file, fs.readFileSync(file, 'utf8')]))
const encoded = Buffer.from(JSON.stringify(filesByPath), 'utf8').toString('base64')
console.log('SME_PATCH_BEGIN', encoded.length)
for (let i = 0; i < encoded.length; i += 1400) console.log('SME_PATCH_CHUNK', i / 1400, encoded.slice(i, i + 1400))
console.log('SME_PATCH_END')
