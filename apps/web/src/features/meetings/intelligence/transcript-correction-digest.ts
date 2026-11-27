import { CoreApiError } from '@/lib/core-api'

export type TranscriptCorrectionDigestSegment = {
  ordinal: number
  startMs: number
  endMs: number
  text: string
}

function invalidDigestInput(message: string): CoreApiError {
  return new CoreApiError({
    message,
    code: 'DIGEST_INPUT_INVALID',
    kind: 'malformed',
  })
}

/**
 * The browser-side copy of Core's TranscriptCorrectionDigest contract.
 *
 * The operator workflow intentionally keeps its own independently verifiable
 * adapter. This ordinary-workspace helper is kept in the transcript feature
 * so the protected operator workflow remains an independent boundary.
 */
export async function computeTranscriptCorrectionDigest(
  segments: readonly TranscriptCorrectionDigestSegment[]
): Promise<string> {
  if (
    typeof globalThis.TextEncoder !== 'function' ||
    typeof globalThis.crypto?.subtle?.digest !== 'function'
  ) {
    throw new CoreApiError({
      message: 'Browser cryptography is unavailable for transcript evidence.',
      code: 'BROWSER_CRYPTO_UNAVAILABLE',
      kind: 'malformed',
    })
  }

  const encoder = new TextEncoder()
  const parts: Uint8Array[] = [encoder.encode('SME-CONTEXTUAL-CORRECTION-V1\0')]
  const orderedSegments = [...segments].sort(
    (left, right) => left.ordinal - right.ordinal
  )

  for (const segment of orderedSegments) {
    if (
      !Number.isSafeInteger(segment.ordinal) ||
      segment.ordinal < 0 ||
      segment.ordinal > 0x7fffffff ||
      !Number.isSafeInteger(segment.startMs) ||
      segment.startMs < 0 ||
      !Number.isSafeInteger(segment.endMs) ||
      segment.endMs < 0 ||
      segment.endMs < segment.startMs
    ) {
      throw invalidDigestInput(
        'Transcript timing and ordinal values cannot be represented by Core.'
      )
    }

    const text = encoder.encode(segment.text)
    if (text.byteLength > 0x7fffffff) {
      throw invalidDigestInput(
        'Transcript text is too large for Core digest framing.'
      )
    }

    const header = new ArrayBuffer(24)
    const view = new DataView(header)
    view.setInt32(0, segment.ordinal)
    view.setBigInt64(4, BigInt(segment.startMs))
    view.setBigInt64(12, BigInt(segment.endMs))
    view.setInt32(20, text.byteLength)
    parts.push(new Uint8Array(header), text)
  }

  const totalBytes = parts.reduce((total, part) => total + part.byteLength, 0)
  const canonical = new Uint8Array(totalBytes)
  let offset = 0
  for (const part of parts) {
    canonical.set(part, offset)
    offset += part.byteLength
  }

  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', canonical)
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
  } catch (error) {
    throw new CoreApiError({
      message: 'Transcript evidence digest computation failed.',
      code: 'DIGEST_COMPUTATION_FAILED',
      kind: 'malformed',
      cause: error,
    })
  }
}
