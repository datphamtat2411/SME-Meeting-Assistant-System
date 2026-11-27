import { describe, expect, it } from 'vitest'
import type { Room } from './room-api'
import {
  deriveRoomPatchIntent,
  reconcileRoomEdit,
  resolveRoomEditReconciliation,
  roomEditableValuesFromRoom,
  roomFormValuesFromEditableValues,
} from './room-reconciliation'

const room: Room = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'BOARD-1',
  name: 'Boardroom',
  location: 'HQ',
  capacity: 8,
  status: 'ACTIVE' as const,
  notes: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
}

function snapshot(changes: Partial<typeof room>, etag: string) {
  return { room: { ...room, ...changes }, etag }
}

describe('Room edit reconciliation', () => {
  it('keeps a user name change while adopting an independent server capacity change', () => {
    const original = snapshot({}, 'original')
    const latest = snapshot({ capacity: 20 }, 'latest')
    const result = reconcileRoomEdit(
      original,
      { name: 'Conference Room' },
      latest
    )

    expect(result.conflicts).toEqual([])
    expect(result.values).toMatchObject({
      name: 'Conference Room',
      capacity: 20,
    })
    expect(result.patch).toEqual({ name: 'Conference Room' })
  })

  it('requires an explicit choice when both sides changed a field differently', () => {
    const result = reconcileRoomEdit(
      snapshot({}, 'original'),
      { name: 'Conference Room' },
      snapshot({ name: 'Executive Room' }, 'latest')
    )

    expect(result.fields.name.outcome).toBe('conflict')
    expect(result.values.name).toBe('Executive Room')
    expect(resolveRoomEditReconciliation(result, {})).toEqual({
      status: 'unresolved',
      unresolvedFields: ['name'],
    })
  })

  it('does not create a redundant patch when both sides reached the same value', () => {
    const result = reconcileRoomEdit(
      snapshot({}, 'original'),
      { name: 'Conference Room' },
      snapshot({ name: 'Conference Room' }, 'latest')
    )

    expect(result.fields.name.outcome).toBe('same')
    expect(result.patch).toEqual({})
    expect(resolveRoomEditReconciliation(result, {}).status).toBe('resolved')
  })

  it('supports accepting either the server or intended value for a conflict', () => {
    const result = reconcileRoomEdit(
      snapshot({}, 'original'),
      { name: 'Conference Room' },
      snapshot({ name: 'Executive Room' }, 'latest')
    )

    expect(
      resolveRoomEditReconciliation(result, { name: 'server' })
    ).toMatchObject({
      status: 'resolved',
      values: { name: 'Executive Room' },
      patch: {},
    })
    expect(
      resolveRoomEditReconciliation(result, { name: 'intent' })
    ).toMatchObject({
      status: 'resolved',
      values: { name: 'Conference Room' },
      patch: { name: 'Conference Room' },
    })
  })

  it('normalizes nullable metadata and derives intent from the original reviewed snapshot', () => {
    const original = snapshot(
      { location: 'HQ', notes: 'Whiteboard', capacity: 8 },
      'original'
    )
    const values = roomFormValuesFromEditableValues(
      original.room,
      roomEditableValuesFromRoom({
        ...original.room,
        location: null,
        notes: null,
        capacity: 8,
      })
    )
    expect(
      deriveRoomPatchIntent(original, {
        ...values,
        name: ' Boardroom ',
        location: ' ',
        capacity: '8',
        notes: ' ',
      })
    ).toEqual({ location: null, notes: null })
  })

  it('uses the reviewed latest version as the new sparse-patch baseline', () => {
    const original = snapshot({}, 'original')
    const latest = snapshot({ capacity: 20 }, 'latest')
    const result = reconcileRoomEdit(
      original,
      { name: 'Conference Room' },
      latest
    )
    const resolved = resolveRoomEditReconciliation(result, {})

    expect(resolved).toMatchObject({
      status: 'resolved',
      patch: { name: 'Conference Room' },
    })
    expect(result.latest.etag).toBe('latest')
    expect(result.patch).not.toHaveProperty('capacity')
  })

  it('recognizes when every intended value is already authoritative', () => {
    const result = reconcileRoomEdit(
      snapshot({}, 'original'),
      { name: 'Conference Room', location: null },
      snapshot({ name: 'Conference Room', location: null }, 'latest')
    )

    expect(result.patch).toEqual({})
    expect(result.fields.name.outcome).toBe('same')
    expect(result.fields.location.outcome).toBe('same')
  })
})
