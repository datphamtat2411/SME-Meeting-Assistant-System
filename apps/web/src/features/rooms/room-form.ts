import { z } from 'zod'
import type { Room } from './room-api'

const maxRoomCapacity = 2_147_483_647
const capacityInputSchema = z
  .string()
  .trim()
  .refine(
    (value) => {
      if (value === '') return true
      if (!/^\d+$/.test(value)) return false
      const capacity = Number(value)
      return (
        Number.isSafeInteger(capacity) &&
        capacity > 0 &&
        capacity <= maxRoomCapacity
      )
    },
    {
      message:
        'Capacity must be a positive whole number within the supported range.',
    }
  )

export const roomFormSchema = z.object({
  code: z.string().trim().min(1, 'Room code is required.').max(64),
  name: z
    .string()
    .trim()
    .min(1, 'Room name is required.')
    .max(160, 'Room name must be 160 characters or fewer.'),
  location: z
    .string()
    .trim()
    .max(255, 'Location must be 255 characters or fewer.'),
  capacity: capacityInputSchema,
  notes: z.string().trim(),
})

export type RoomFormValues = z.input<typeof roomFormSchema>

export class NoRoomChangesError extends Error {
  constructor() {
    super('No changes to save.')
    this.name = 'NoRoomChangesError'
  }
}

function normalizedCapacity(value: string): number | null {
  const normalized = value.trim()
  return normalized ? Number(normalized) : null
}

function normalizedOptionalText(value: string): string | null {
  const normalized = value.trim()
  return normalized || null
}

export function roomFormValuesFromRoom(room: Room): RoomFormValues {
  return {
    code: room.code,
    name: room.name,
    location: room.location ?? '',
    capacity: room.capacity === null ? '' : String(room.capacity),
    notes: room.notes ?? '',
  }
}

export function buildRoomCreatePayload(values: RoomFormValues) {
  const normalized = roomFormSchema.parse(values)
  return {
    code: normalized.code.toLocaleUpperCase('en-US'),
    name: normalized.name,
    location: normalizedOptionalText(normalized.location),
    capacity: normalizedCapacity(normalized.capacity),
    notes: normalizedOptionalText(normalized.notes),
  }
}

export function buildRoomPatchPayload(
  current: Room,
  values: RoomFormValues
): {
  name?: string
  location?: string | null
  capacity?: number | null
  notes?: string | null
} {
  const normalized = roomFormSchema.parse(values)
  const payload: {
    name?: string
    location?: string | null
    capacity?: number | null
    notes?: string | null
  } = {}
  if (normalized.name !== current.name) payload.name = normalized.name

  const location = normalizedOptionalText(normalized.location)
  if (location !== current.location) payload.location = location

  const capacity = normalizedCapacity(normalized.capacity)
  if (capacity !== current.capacity) payload.capacity = capacity

  const notes = normalizedOptionalText(normalized.notes)
  if (notes !== current.notes) payload.notes = notes

  if (Object.keys(payload).length === 0) throw new NoRoomChangesError()
  return payload
}
