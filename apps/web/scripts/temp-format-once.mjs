import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const file = 'src/features/meetings/intelligence/transcript-api.ts'
execFileSync('node_modules/.bin/prettier', ['--write', file, 'scripts/temp-format-once.mjs'], { stdio: 'pipe' })
console.log('SME_TRANSCRIPT', fs.readFileSync(file).toString('base64'))
