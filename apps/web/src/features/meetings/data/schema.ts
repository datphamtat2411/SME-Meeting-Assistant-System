export type MeetingStatus =
  | 'scheduled'
  | 'in_progress'
  | 'processing'
  | 'completed'
  | 'cancelled'

export type ProcessingStage =
  | 'uploaded'
  | 'transcribing'
  | 'diarizing'
  | 'summarizing'
  | 'extracting'
  | 'indexing'
  | 'ready'

export type MemberRole = 'employee' | 'manager' | 'admin'
export type MemberStatus = 'active' | 'inactive' | 'invited'
export type MeetingRoomStatus = 'available' | 'occupied' | 'maintenance'
export type ActionItemStatus = 'todo' | 'in_progress' | 'done'
export type ActionItemPriority = 'low' | 'medium' | 'high'
export type RagSourceType =
  | 'transcript'
  | 'summary'
  | 'decision'
  | 'action_item'
export type AssistantMessageRole = 'user' | 'assistant'

export type Meeting = {
  id: string
  title: string
  description: string
  status: MeetingStatus
  startsAt: string
  endsAt: string
  organizerId: string
  participantIds: string[]
  roomId: string
  processingStage?: ProcessingStage
}

export type Member = {
  id: string
  name: string
  email: string
  department: string
  role: MemberRole
  status: MemberStatus
  avatar: string | null
}

export type MeetingRoom = {
  id: string
  name: string
  location: string
  capacity: number
  status: MeetingRoomStatus
  equipment: string[]
}

export type TranscriptSegment = {
  id: string
  meetingId: string
  speakerLabel: string
  participantId?: string
  startMs: number
  endMs: number
  text: string
  isFinal: boolean
}

export type MeetingSummary = {
  meetingId: string
  overview: string
  highlights: string[]
}

export type KeyDecision = {
  id: string
  meetingId: string
  text: string
  sourceSegmentId?: string
}

export type ActionItem = {
  id: string
  meetingId: string
  title: string
  description: string
  assigneeId: string
  status: ActionItemStatus
  priority: ActionItemPriority
  dueDate: string
  sourceSegmentId?: string
}

export type RagSource = {
  id: string
  meetingId: string
  sourceType: RagSourceType
  segmentId: string
  timestampMs: number
  excerpt: string
}

export type AssistantMessage = {
  id: string
  conversationId: string
  role: AssistantMessageRole
  content: string
  createdAt: string
  sourceIds?: string[]
}

export type AssistantConversation = {
  id: string
  meetingId?: string
  title: string
  messages: AssistantMessage[]
}
