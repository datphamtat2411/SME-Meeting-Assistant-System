import { describe, expect, it } from 'vitest'
import { computeTranscriptCorrectionDigest } from './transcript-correction-digest'

describe('Core-compatible transcript correction digest', () => {
  it('matches the empty transcript fixture', async () => {
    await expect(computeTranscriptCorrectionDigest([])).resolves.toBe(
      'da5f8cd6ead91181a26a8c323f078baf716dea5c8c0f7c9b4341b9b172b34545'
    )
  })

  it('preserves Vietnamese Unicode and multiline UTF-8 text', async () => {
    await expect(
      computeTranscriptCorrectionDigest([
        {
          ordinal: 2,
          startMs: 2000,
          endMs: 3000,
          text: 'Nội dung\ncuộc họp',
        },
        {
          ordinal: 1,
          startMs: 0,
          endMs: 1500,
          text: 'Xin chào',
        },
      ])
    ).resolves.toBe(
      'b31710a4f182b4314b8c5b180ff84423b77a8a4034070d8dd6887da5dac45901'
    )
  })

  it('sorts by ordinal and binds byte lengths rather than display length', async () => {
    await expect(
      computeTranscriptCorrectionDigest([
        { ordinal: 10, startMs: 100, endMs: 200, text: 'a' },
        { ordinal: 2, startMs: 0, endMs: 50, text: 'b' },
        { ordinal: 7, startMs: 50, endMs: 100, text: 'c' },
      ])
    ).resolves.toBe(
      'a0ea9210c68ef57116dd8fcee03d7dd4f194de8eac359bb8be42fc838f5c9f00'
    )

    await expect(
      computeTranscriptCorrectionDigest([
        { ordinal: 0, startMs: 0, endMs: 1, text: 'é' },
        { ordinal: 1, startMs: 1, endMs: 2, text: '😊' },
      ])
    ).resolves.toBe(
      '667e307590a35367ba147201a22d71ffd049be5e4b56501fab4332a99798f957'
    )
  })

  it('rejects values that cannot be represented by Core framing', async () => {
    await expect(
      computeTranscriptCorrectionDigest([
        {
          ordinal: 0,
          startMs: 0.5,
          endMs: 1,
          text: 'unsafe',
        },
      ])
    ).rejects.toMatchObject({ code: 'DIGEST_INPUT_INVALID' })
  })
})
