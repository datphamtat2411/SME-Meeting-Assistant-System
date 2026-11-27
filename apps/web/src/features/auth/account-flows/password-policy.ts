import { z } from 'zod'
import { featureValidationMessage } from '@/lib/i18n/presentation'

export function validNewPassword(value: string): boolean {
  const length = Array.from(value).length
  return length >= 15 && length <= 128
}

export const credentialSchema = z
  .object({
    password: z.string().refine(validNewPassword, {
      message: featureValidationMessage('auth:passwordLength'),
    }),
    confirmPassword: z
      .string()
      .min(1, featureValidationMessage('auth:confirmationRequired')),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: featureValidationMessage('auth:passwordMismatch'),
    path: ['confirmPassword'],
  })

export type CredentialFields = z.infer<typeof credentialSchema>
