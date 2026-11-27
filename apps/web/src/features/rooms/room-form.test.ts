import { describe, expect, it } from 'vitest'
import {
  buildRoomCreatePayload,
  buildRoomPatchPayload,
  roomFormSchema,
} from './room-form'

const room = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'BOARD-1',
  name: 'Boardroom',
  location: 'HQ',
  capacity: 8,
  status: 'ACTIVE' as const,
  notes: 'Whiteboard',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
}

describe('room form contracts', () => {
  it('rejects whitespace-only required values and capacity outside int32 bounds', () => {
    expect(
      roomFormSchema.safeParse({
        code: '   ',
        name: '   ',
        location: '',
        capacity: '',
        notes: '',
      }).success
    ).toBe(false)
    expect(
      roomFormSchema.safeParse({
        code: 'A',
        name: 'Room',
        location: '',
        capacity: '2147483648',
        notes: '',
      }).success
    ).toBe(false)
  })

  it('normalizes creation values and represents blank optional fields as null', () => {
    expect(
      buildRoomCreatePayload({
        code: ' board-2 ',
        name: ' Board room ',
        location: '   ',
        capacity: '',
        notes: '\n ',
      })
    ).toEqual({
      code: 'BOARD-2',
      name: 'Board room',
      location: null,
      capacity: null,
      notes: null,
    })
  })

  it('builds a sparse PATCH and uses explicit null only to clear changed metadata', () => {
    expect(
      buildRoomPatchPayload(room, {
        code: room.code,
        name: 'Boardroom',
        location: '',
        capacity: '8',
        notes: ' Whiteboard ',
      })
    ).toEqual({ location: null })
    expect(() =>
      buildRoomPatchPayload(room, {
        code: room.code,
        name: 'Boardroom',
        location: 'HQ',
        capacity: '8',
        notes: 'Whiteboard',
      })
    ).toThrow(/no changes/i)
    expect(
      buildRoomPatchPayload(room, {
        code: room.code,
        name: 'Boardroom 2',
        location: 'HQ',
        capacity: '8',
        notes: 'Whiteboard',
      })
    ).toEqual({ name: 'Boardroom 2' })
  })
})
