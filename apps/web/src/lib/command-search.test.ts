import { describe, expect, it } from 'vitest'
import { commandSearchScore } from './command-search'

const meetingValue = 'General Meetings /meetings'
const roomValue = 'General Meeting Rooms /rooms'
const meetingKeywords = ['General', 'Meetings', 'Chung', 'Cuộc họp']
const roomKeywords = ['General', 'Meeting Rooms', 'Chung', 'Phòng họp']

const meeting = (query: string) =>
  commandSearchScore(meetingValue, query, meetingKeywords)
const room = (query: string) =>
  commandSearchScore(roomValue, query, roomKeywords)

describe('commandSearchScore', () => {
  it('does not match unrelated routes through fuzzy aliases', () => {
    expect(meeting(meetingValue)).toBe(1)
    expect(room(meetingValue)).toBe(0)
    expect(room('/meetings')).toBe(0)
  })

  it.each(['Cuộc họp', 'cuoc hop', 'CUỘC HỌP'])(
    'normalizes Vietnamese labels and queries: %s',
    (query) => {
      expect(meeting(query)).toBe(1)
      expect(room(query)).toBe(0)
    }
  )

  it('requires every query term to match', () => {
    expect(meeting('General cuoc hop')).toBeGreaterThan(0)
    expect(meeting('cuoc hop unknown')).toBe(0)
    expect(meeting('cuoc hop /rooms')).toBe(0)
  })

  it('supports partial labels and paths with exact-match priority', () => {
    expect(meeting('meet')).toBeGreaterThan(0)
    expect(meeting('/meet')).toBeGreaterThan(0)
    expect(meeting('Meetings')).toBeGreaterThan(meeting('meet'))
    expect(meeting('zzzz')).toBe(0)
  })
})
