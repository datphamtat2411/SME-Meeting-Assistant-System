// Temporary CI formatting snapshot. Removed after sources are normalized.
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const files = [
  "src/components/request-state.tsx",
  "src/features/action-items/action-api.ts",
  "src/features/action-items/action-commands.tsx",
  "src/features/action-items/action-form.tsx",
  "src/features/action-items/index.tsx",
  "src/features/assistant/index.tsx",
  "src/features/auth/account-flows-api.ts",
  "src/features/auth/forgot-password/components/forgot-password-form.tsx",
  "src/features/auth/forgot-password/index.tsx",
  "src/features/auth/otp/index.tsx",
  "src/features/auth/password-token-form.tsx",
  "src/features/auth/sign-up/index.tsx",
  "src/features/calendar/calendar-api.ts",
  "src/features/calendar/index.tsx",
  "src/features/dashboard/dashboard-api.ts",
  "src/features/dashboard/index.tsx",
  "src/features/meetings/intelligence/decision-api.ts",
  "src/features/meetings/intelligence/decisions-panel.tsx",
  "src/features/meetings/intelligence/export-api.ts",
  "src/features/meetings/intelligence/export-panel.tsx",
  "src/features/meetings/intelligence/minutes-api.ts",
  "src/features/meetings/intelligence/minutes-panel.tsx",
  "src/features/meetings/intelligence/speakers-panel.tsx",
  "src/features/meetings/intelligence/summary-api.ts",
  "src/features/meetings/intelligence/summary-panel.tsx",
  "src/features/meetings/intelligence/transcript-api.ts",
  "src/features/meetings/intelligence/transcript-panel.tsx",
  "src/features/meetings/media/media-api.ts",
  "src/features/meetings/media/processing-api.ts",
  "src/features/meetings/media/processing-panel.tsx",
  "src/features/meetings/media/recording-panel.tsx",
  "src/features/meetings/media/upload-panel.tsx",
  "src/features/meetings/meeting-tools.tsx",
  "src/features/meetings/meeting-workspace.tsx",
  "src/features/members/index.tsx",
  "src/features/members/member-api.ts",
  "src/features/members/organization-api.ts",
  "src/features/rooms/index.tsx",
  "src/features/rooms/room-api.ts",
  "src/features/settings/account/account-form.tsx",
  "src/features/settings/notifications/notifications-form.tsx",
  "src/features/settings/preferences-api.ts",
  "src/features/settings/profile/profile-api.ts",
  "src/features/settings/profile/profile-form.tsx",
  "src/lib/list-pagination.ts"
]
const formatted = {}
try {
  execFileSync('node_modules/.bin/prettier', ['--write', ...files], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
} catch (error) {
  console.log('SME_FORMAT_CLI_ERROR', String(error?.stderr ?? error?.message ?? error).slice(0, 2000))
}
for (const file of files) {
  formatted[file] = await fs.readFile(file, 'utf8')
}
const encoded = Buffer.from(JSON.stringify(formatted), 'utf8').toString('base64')
console.log('SME_FORMAT_BEGIN', files.length, encoded.length)
for (let i = 0; i < encoded.length; i += 1400) console.log('SME_FORMAT_CHUNK', i / 1400, encoded.slice(i, i + 1400))
console.log('SME_FORMAT_END')
