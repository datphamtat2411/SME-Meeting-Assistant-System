import { z } from 'zod'

export function validNewPassword(value: string): boolean {
  const length = Array.from(value).length
  return length >= 15 && length <= 128
}

export const credentialSchema = z
  .object({
    password: z.string().refine(validNewPassword, {
      message: 'Use 15–128 Unicode characters.',
    }),
    confirmPassword: z.string().min(1, 'Please confirm your password.'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match.",
    path: ['confirmPassword'],
  })

export type CredentialFields = z.infer<typeof credentialSchema>
