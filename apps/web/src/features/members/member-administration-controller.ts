import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import type { AuthContext } from '@/features/auth/session/current-user'
import type { MemberDirectoryAccess } from './member-access-policy'
import { changeMemberStatus, memberDetail, type Member } from './member-api'

export type MemberLifecycleAction =
  | 'deactivate'
  | 'reactivate'
  | 'account-setup/reissue'

class ObsoleteMemberOperationError extends Error {
  constructor() {
    super(
      'Member-management authorization changed before the operation started.'
    )
    this.name = 'ObsoleteMemberOperationError'
  }
}

interface MemberAdministrationControllerOptions {
  access: MemberDirectoryAccess
  accessKey: string
  identity?: AuthContext
  identityVerified: boolean
}

export function useMemberAdministrationController({
  access,
  accessKey,
  identity,
  identityVerified,
}: MemberAdministrationControllerOptions) {
  const queryClient = useQueryClient()
  const currentAuthorization = useRef({ accessKey, identityVerified })
  const statusOperationInFlight = useRef(false)
  const previousAccessKey = useRef(accessKey)
  const [administrationDialog, setAdministrationDialog] = useState<{
    contextKey: string
    member: Member | null
  } | null>(null)

  useLayoutEffect(() => {
    currentAuthorization.current = { accessKey, identityVerified }
  }, [accessKey, identityVerified])

  useEffect(() => {
    if (previousAccessKey.current === accessKey) return
    previousAccessKey.current = accessKey
    setAdministrationDialog(null)
  }, [accessKey])

  const statusMutation = useMutation({
    mutationFn: async ({
      member,
      action,
      contextKey,
    }: {
      member: Member
      action: MemberLifecycleAction
      contextKey: string
    }) => {
      if (
        currentAuthorization.current.accessKey !== contextKey ||
        !currentAuthorization.current.identityVerified
      ) {
        throw new ObsoleteMemberOperationError()
      }
      const fresh = await memberDetail(member.id)
      if (
        currentAuthorization.current.accessKey !== contextKey ||
        !currentAuthorization.current.identityVerified
      ) {
        throw new ObsoleteMemberOperationError()
      }
      return changeMemberStatus(member.id, action, fresh.etag)
    },
    onSuccess: async (_result, input) => {
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      if (currentAuthorization.current.accessKey === input.contextKey) {
        toast.success('Account updated')
      }
    },
    onError: (error, input) => {
      if (
        error instanceof ObsoleteMemberOperationError ||
        currentAuthorization.current.accessKey !== input.contextKey
      ) {
        return
      }
      toast.error('Account update failed', {
        description:
          normalizeCoreApiError(error).message ||
          'The account was not updated.',
      })
    },
    onSettled: () => {
      statusOperationInFlight.current = false
    },
  })
  const { mutate: mutateStatus, isPending: statusMutationPending } =
    statusMutation

  const openAdministration = useCallback(
    (member: Member | null) => {
      if (
        !identityVerified ||
        access.type !== 'authorized' ||
        statusOperationInFlight.current ||
        statusMutationPending ||
        currentAuthorization.current.accessKey !== accessKey
      ) {
        return
      }
      setAdministrationDialog({ contextKey: accessKey, member })
    },
    [access.type, accessKey, identityVerified, statusMutationPending]
  )

  const runLifecycle = useCallback(
    (member: Member, action: MemberLifecycleAction) => {
      if (
        !identityVerified ||
        access.type !== 'authorized' ||
        currentAuthorization.current.accessKey !== accessKey
      ) {
        return
      }
      const actionLabel = action.replace(/\//g, ' ')
      if (!window.confirm(`Apply ${actionLabel} to ${member.displayName}?`)) {
        return
      }
      if (
        !currentAuthorization.current.identityVerified ||
        currentAuthorization.current.accessKey !== accessKey ||
        statusOperationInFlight.current
      ) {
        return
      }
      statusOperationInFlight.current = true
      mutateStatus({ member, action, contextKey: accessKey })
    },
    [access.type, accessKey, identityVerified, mutateStatus]
  )

  const closeAdministration = useCallback(() => {
    setAdministrationDialog(null)
  }, [])

  return {
    administrationDialog,
    openAdministration,
    closeAdministration,
    runLifecycle,
    statusMutationPending,
    identity,
    authorizationKey: accessKey,
    authorizationVerified: identityVerified,
    isAuthorizationContextCurrent: (key: string) =>
      currentAuthorization.current.accessKey === key,
  }
}

export type MemberAdministrationController = ReturnType<
  typeof useMemberAdministrationController
>
