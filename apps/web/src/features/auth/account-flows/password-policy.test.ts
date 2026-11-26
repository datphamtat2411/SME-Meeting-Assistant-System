import { describe, expect, it } from 'vitest'
import { credentialSchema, validNewPassword } from './password-policy'

describe('account credential policy', () => {
  it.each([14, 15, 128, 129])('counts %i Unicode code points', (length) => {
    const password = '🔒'.repeat(length)
    expect(validNewPassword(password)).toBe(length >= 15 && length <= 128)
  })

  it('preserves Vietnamese characters and whitespace exactly', () => {
    const password = '  Mật khẩu riêng 🔒  '
    const result = credentialSchema.parse({
      password,
      confirmPassword: password,
    })
    expect(result.password).toBe(password)
    expect(
      credentialSchema.safeParse({
        password,
        confirmPassword: password.trim(),
      }).success
    ).toBe(false)
  })
})
