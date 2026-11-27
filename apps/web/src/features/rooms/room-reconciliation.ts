import { z } from 'zod'
import type { Room, RoomPatchPayload, RoomSnapshot } from './room-api'
import { roomFormSchema, type RoomFormValues } from './room-form'

export const roomEditableFields = [
  'name',
  'location',
  'capacity',
  'notes',
] as const

export type RoomEditableField = (typeof roomEditableFields)[number]
export type RoomEditableValue = string | number | null

export type RoomEditableValues = {
  [Field in RoomEditableField]: RoomEditableValue
}

export type RoomFieldReconciliationOutcome =
  | 'unchanged'
  | 'server-changed'
  | 'user-changed'
  | 'same'
  | 'conflict'

export interface RoomFieldReconciliation {
  field: RoomEditableField
  original: RoomEditableValue
  intended?: RoomEditableValue
  latest: RoomEditableValue
  userChanged: boolean
  serverChanged: boolean
  outcome: RoomFieldReconciliationOutcome
}

export interface RoomEditReconciliation {
  original: RoomSnapshot
  latest: RoomSnapshot
  intent: RoomPatchPayload
  values: RoomEditableValues
  fields: Record<RoomEditableField, RoomFieldReconciliation>
  conflicts: readonly RoomEditableField[]
  patch: RoomPatchPayload
}

export type RoomConflictChoice = 'server' | 'intent'
export type RoomConflictChoices = Partial<
  Record<RoomEditableField, RoomConflictChoice>
>

type ResolvedRoomEditReconciliation =
  | {
      status: 'unresolved'
      unresolvedFields: readonly RoomEditableField[]
    }
  | {
      status: 'resolved'
      values: RoomEditableValues
      patch: RoomPatchPayload
    }

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    location: z.string().trim().max(255).nullable().optional(),
    capacity: z
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .nullable()
      .optional(),
    notes: z.string().nullable().optional(),
  })
  .strict()

class InvalidRoomReconciliationInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRoomReconciliationInputError'
  }
}

function nullableText(value: string | null): string | null {
  return value?.trim() || null
}

function canonicalValue(
  field: RoomEditableField,
  value: RoomEditableValue
): RoomEditableValue {
  if (field === 'name') {
    if (typeof value !== 'string') {
      throw new InvalidRoomReconciliationInputError(
        'Room name must be a string.'
      )
    }
    return value.trim()
  }
  if (field === 'location' || field === 'notes') {
    if (value !== null && typeof value !== 'string') {
      throw new InvalidRoomReconciliationInputError(
        `Room ${field} must be text or null.`
      )
    }
    return nullableText(value)
  }
  if (value !== null && typeof value !== 'number') {
    throw new InvalidRoomReconciliationInputError(
      'Room capacity must be a number or null.'
    )
  }
  return value
}

function valuesFromRoom(room: Room): RoomEditableValues {
  return {
    name: canonicalValue('name', room.name),
    location: canonicalValue('location', room.location),
    capacity: canonicalValue('capacity', room.capacity),
    notes: canonicalValue('notes', room.notes),
  }
}

export function roomEditableValuesFromRoom(room: Room): RoomEditableValues {
  return valuesFromRoom(room)
}

function roomEditableValuesFromForm(
  values: RoomFormValues
): RoomEditableValues {
  const parsed = roomFormSchema.parse(values)
  return {
    name: canonicalValue('name', parsed.name),
    location: canonicalValue('location', parsed.location),
    capacity: parsed.capacity.trim() ? Number(parsed.capacity.trim()) : null,
    notes: canonicalValue('notes', parsed.notes),
  }
}

export function roomFormValuesFromEditableValues(
  room: Room,
  values: RoomEditableValues
): RoomFormValues {
  return {
    code: room.code,
    name: String(values.name),
    location: values.location === null ? '' : String(values.location),
    capacity: values.capacity === null ? '' : String(values.capacity),
    notes: values.notes === null ? '' : String(values.notes),
  }
}

function valuesEqual(
  field: RoomEditableField,
  first: RoomEditableValue,
  second: RoomEditableValue
): boolean {
  return canonicalValue(field, first) === canonicalValue(field, second)
}

function patchValue(
  field: RoomEditableField,
  value: RoomEditableValue
): string | number | null {
  return canonicalValue(field, value)
}

function setPatchValue(
  patch: RoomPatchPayload,
  field: RoomEditableField,
  value: RoomEditableValue
): void {
  const canonical = patchValue(field, value)
  if (field === 'name') patch.name = canonical as string
  if (field === 'location') patch.location = canonical as string | null
  if (field === 'capacity') patch.capacity = canonical as number | null
  if (field === 'notes') patch.notes = canonical as string | null
}

function patchFromValues(
  baseline: RoomEditableValues,
  values: RoomEditableValues
): RoomPatchPayload {
  const patch: RoomPatchPayload = {}
  for (const field of roomEditableFields) {
    if (!valuesEqual(field, baseline[field], values[field])) {
      setPatchValue(patch, field, values[field])
    }
  }
  return patch
}

function normalizeRoomPatchIntent(payload: RoomPatchPayload): RoomPatchPayload {
  const parsed = patchSchema.safeParse(payload)
  if (!parsed.success) {
    throw new InvalidRoomReconciliationInputError(
      'The submitted room edit intent is invalid.'
    )
  }
  const normalized: RoomPatchPayload = {}
  for (const field of roomEditableFields) {
    if (field in parsed.data) {
      setPatchValue(normalized, field, parsed.data[field] as RoomEditableValue)
    }
  }
  if (Object.keys(normalized).length === 0) {
    throw new InvalidRoomReconciliationInputError(
      'The submitted room edit intent is empty.'
    )
  }
  return normalized
}

export function deriveRoomPatchIntent(
  original: RoomSnapshot,
  values: RoomFormValues
): RoomPatchPayload {
  const originalValues = valuesFromRoom(original.room)
  const intendedValues = roomEditableValuesFromForm(values)
  return patchFromValues(originalValues, intendedValues)
}

export function reconcileRoomEdit(
  original: RoomSnapshot,
  intentPayload: RoomPatchPayload,
  latest: RoomSnapshot
): RoomEditReconciliation {
  const intent = normalizeRoomPatchIntent(intentPayload)
  const originalValues = valuesFromRoom(original.room)
  const latestValues = valuesFromRoom(latest.room)
  const fields = {} as Record<RoomEditableField, RoomFieldReconciliation>
  const conflicts: RoomEditableField[] = []
  const values = { ...latestValues }

  for (const field of roomEditableFields) {
    const userChanged = field in intent
    const intended = userChanged
      ? canonicalValue(field, intent[field] as RoomEditableValue)
      : undefined
    const serverChanged = !valuesEqual(
      field,
      originalValues[field],
      latestValues[field]
    )
    let outcome: RoomFieldReconciliationOutcome

    if (!userChanged && !serverChanged) {
      outcome = 'unchanged'
    } else if (!userChanged) {
      outcome = 'server-changed'
    } else if (!serverChanged) {
      outcome = 'user-changed'
      values[field] = intended as RoomEditableValue
    } else if (valuesEqual(field, intended!, latestValues[field])) {
      outcome = 'same'
      values[field] = latestValues[field]
    } else {
      outcome = 'conflict'
      conflicts.push(field)
    }

    fields[field] = {
      field,
      original: originalValues[field],
      ...(userChanged ? { intended } : {}),
      latest: latestValues[field],
      userChanged,
      serverChanged,
      outcome,
    }
  }

  return {
    original,
    latest,
    intent,
    values,
    fields,
    conflicts,
    patch: patchFromValues(latestValues, values),
  }
}

export function resolveRoomEditReconciliation(
  reconciliation: RoomEditReconciliation,
  choices: RoomConflictChoices
): ResolvedRoomEditReconciliation {
  const unresolvedFields = reconciliation.conflicts.filter(
    (field) => choices[field] === undefined
  )
  if (unresolvedFields.length > 0) {
    return { status: 'unresolved', unresolvedFields }
  }

  const values = { ...reconciliation.values }
  for (const field of reconciliation.conflicts) {
    const choice = choices[field]
    const fieldResult = reconciliation.fields[field]
    values[field] =
      choice === 'intent'
        ? (fieldResult.intended as RoomEditableValue)
        : fieldResult.latest
  }

  return {
    status: 'resolved',
    values,
    patch: patchFromValues(valuesFromRoom(reconciliation.latest.room), values),
  }
}
