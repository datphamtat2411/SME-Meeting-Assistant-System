import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Search, Users } from 'lucide-react'
import { toast } from 'sonner'
import { RequestEmpty, RequestError, RequestLoading } from '@/components/request-state'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import { currentUserQueryOptions } from '@/features/auth/session/current-user'
import { organizationalUnitsQuery } from './organization-api'
import { changeMemberStatus, createMember, memberDetail, membersQuery, updateMember, type Member } from './member-api'

type Draft = { email: string; displayName: string; globalRole: Member['globalRole']; primaryOrgUnitId: string }
const blank: Draft = { email: '', displayName: '', globalRole: 'EMPLOYEE', primaryOrgUnitId: '' }

export function MembersPage() {
  const qc = useQueryClient()
  const identity = useQuery(currentUserQueryOptions())
  const canManage = identity.data?.globalRole === 'ADMINISTRATOR' || identity.data?.globalRole === 'DEPARTMENT_MANAGER'
  const isAdmin = identity.data?.globalRole === 'ADMINISTRATOR'
  const [page, setPage] = useState(0)
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const members = useQuery({ ...membersQuery(page, search), enabled: Boolean(canManage) })
  const units = useQuery({ ...organizationalUnitsQuery(), enabled: Boolean(canManage) })
  const [selected, setSelected] = useState<Member | null>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(blank)
  const [busy, setBusy] = useState(false)
  const mutation = useMutation({
    mutationFn: async (data: Draft) => {
      const input = { displayName: data.displayName.trim(), primaryOrgUnitId: data.primaryOrgUnitId || null }
      if (!selected) return createMember({ ...input, email: data.email.trim(), globalRole: isAdmin ? data.globalRole : 'EMPLOYEE' })
      const fresh = await memberDetail(selected.id)
      return updateMember(selected.id, { ...input, ...(isAdmin ? { globalRole: data.globalRole } : {}) }, fresh.etag)
    },
    onSuccess: () => { toast.success(selected ? 'Member updated' : 'Account created: setup invitation pending'); setOpen(false); void qc.invalidateQueries({ queryKey: ['users'] }) },
    onError: error => toast.error('Unable to save member', { description: error instanceof Error ? error.message : undefined }),
  })
  useEffect(() => { if (!open) setDraft(blank) }, [open])
  function edit(member: Member | null) {
    setSelected(member)
    setDraft(member ? { email: member.email, displayName: member.displayName, globalRole: member.globalRole, primaryOrgUnitId: member.primaryOrgUnitId ?? '' } : { ...blank })
    setOpen(true)
  }
  async function lifecycle(member: Member, action: 'deactivate' | 'reactivate' | 'account-setup/reissue') {
    if (!window.confirm('Apply ' + action.replaceAll('/', ' ') + ' to ' + member.displayName + '?')) return
    setBusy(true)
    try {
      const fresh = await memberDetail(member.id)
      await changeMemberStatus(member.id, action, fresh.etag)
      toast.success('Account updated')
      await qc.invalidateQueries({ queryKey: ['users'] })
    } catch (error) { toast.error('Account update failed', { description: error instanceof Error ? error.message : undefined }) }
    finally { setBusy(false) }
  }
  function submit(e: FormEvent) { e.preventDefault(); mutation.mutate(draft) }
  return <>
    <Header fixed><HeaderActions /></Header>
    <Main className='space-y-6'>
      <div className='flex flex-wrap items-end justify-between gap-4'><div><p className='text-sm font-medium text-primary'>Administration</p><h1 className='text-3xl font-bold'>Members</h1><p className='text-muted-foreground'>Managed organizational identities and account setup.</p></div>{canManage && <Button onClick={() => edit(null)}><Plus className='size-4' /> Add member</Button>}</div>
      {!canManage ? <div className='rounded-lg border p-6 text-muted-foreground'>User directory access requires an authorized management role.</div> :
      <Card><CardHeader><CardTitle>Directory</CardTitle><form className='flex gap-2' onSubmit={e => { e.preventDefault(); setPage(0); setSearch(input.trim()) }}><Input value={input} onChange={e => setInput(e.target.value)} placeholder='Search name or email' aria-label='Search members' /><Button type='submit' variant='secondary'><Search className='size-4' /> Search</Button></form></CardHeader>
      <CardContent className='space-y-4'>{members.isPending ? <RequestLoading /> : members.isError ? <RequestError error={members.error} retry={() => void members.refetch()} /> : !members.data.items.length ? <RequestEmpty title='No matching members' /> : <div className='overflow-x-auto'><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Department</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>
      {members.data.items.map(member => <TableRow key={member.id}><TableCell className='font-medium'>{member.displayName}</TableCell><TableCell>{member.email}</TableCell><TableCell>{units.data?.find(u => u.id === member.primaryOrgUnitId)?.name ?? '—'}</TableCell><TableCell><Badge variant='secondary'>{member.globalRole.replaceAll('_', ' ')}</Badge></TableCell><TableCell><Badge variant='outline'>{member.accountStatus}</Badge></TableCell>
      <TableCell><div className='flex flex-wrap gap-1'><Button size='sm' variant='outline' onClick={() => edit(member)}><Pencil className='size-3' /> Edit</Button>
      {member.accountStatus === 'ACTIVE' && member.id !== identity.data?.userId && <Button disabled={busy} size='sm' variant='ghost' onClick={() => void lifecycle(member, 'deactivate')}>Deactivate</Button>}
      {member.accountStatus === 'INACTIVE' && <Button disabled={busy} size='sm' variant='ghost' onClick={() => void lifecycle(member, 'reactivate')}>Reactivate</Button>}
      {member.accountStatus === 'PENDING_SETUP' && <Button disabled={busy} size='sm' variant='ghost' onClick={() => void lifecycle(member, 'account-setup/reissue')}>Resend setup</Button>}
      </div></TableCell></TableRow>)}</TableBody></Table></div>}
      {members.data && <div className='flex items-center justify-between text-sm text-muted-foreground'><span>{members.data.page.totalElements} users</span><div className='flex items-center gap-2'><Button size='sm' variant='outline' disabled={!members.data.page.hasPrevious} onClick={() => setPage(p => p - 1)}>Previous</Button> Page {page + 1} <Button size='sm' variant='outline' disabled={!members.data.page.hasNext} onClick={() => setPage(p => p + 1)}>Next</Button></div></div>}
      </CardContent></Card>}
      <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>{selected ? 'Edit member' : 'Create account'}</DialogTitle><DialogDescription>New accounts are created pending secure setup. Passwords are never set by an administrator.</DialogDescription></DialogHeader>
      <form onSubmit={submit} className='space-y-4'>
      <div className='space-y-1'><Label htmlFor='member-name'>Name</Label><Input id='member-name' maxLength={200} required value={draft.displayName} onChange={e => setDraft(d => ({ ...d, displayName: e.target.value }))} /></div>
      <div className='space-y-1'><Label htmlFor='member-email'>Email</Label><Input id='member-email' type='email' required disabled={Boolean(selected)} value={draft.email} onChange={e => setDraft(d => ({ ...d, email: e.target.value }))} /></div>
      <div className='space-y-1'><Label>Department</Label><Select value={draft.primaryOrgUnitId || 'none'} onValueChange={value => setDraft(d => ({ ...d, primaryOrgUnitId: value === 'none' ? '' : value }))}><SelectTrigger><SelectValue placeholder='Select department' /></SelectTrigger><SelectContent><SelectItem value='none'>Not assigned</SelectItem>{units.data?.filter(u => u.status === 'ACTIVE').map(u => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}</SelectContent></Select></div>
      {isAdmin && <div className='space-y-1'><Label>Global role</Label><Select value={draft.globalRole} onValueChange={value => setDraft(d => ({ ...d, globalRole: value as Member['globalRole'] }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value='EMPLOYEE'>Employee</SelectItem><SelectItem value='DEPARTMENT_MANAGER'>Department manager</SelectItem><SelectItem value='ADMINISTRATOR'>Administrator</SelectItem></SelectContent></Select></div>}
      <DialogFooter><Button variant='outline' type='button' onClick={() => setOpen(false)}>Cancel</Button><Button disabled={mutation.isPending} type='submit'>Save member</Button></DialogFooter>
      </form></DialogContent></Dialog>
    </Main>
  </>
}
