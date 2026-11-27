import { toast } from 'sonner'

export type ActionDraftProtection =
  | 'none'
  | 'dirty'
  | 'pending-creation'
  | 'uncertain-creation'

/** An unresolved creation may only be recovered or abandoned in its form. */
export function blockUnresolvedActionCreation(
  protection: ActionDraftProtection
): boolean {
  if (protection === 'pending-creation') {
    toast.warning('Action Item creation is pending', {
      description: 'Wait for the request outcome before leaving this form.',
    })
    return true
  }
  if (protection === 'uncertain-creation') {
    toast.warning('Action Item creation is unresolved', {
      description:
        'Retry the original creation or explicitly abandon local recovery in the form. The Action Item may already exist.',
    })
    return true
  }
  return false
}
