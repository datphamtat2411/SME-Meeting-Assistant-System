package vn.sme.meetingassistant.sme_meeting_assistant

import org.junit.Assert.*
import org.junit.Test

class AccountLinkBufferTest {
    @Test fun latestPendingIsConsumedOnceWithoutDecoding() {
        val buffer = AccountLinkBuffer()
        assertTrue(buffer.offer("https://example.invalid/otp#token=old"))
        val latest = "https://example.invalid/otp#token=a%2Bb"
        assertTrue(buffer.offer(latest))
        assertEquals(latest, buffer.take())
        assertNull(buffer.take())
    }

    @Test fun unsupportedOrOversizedInputDoesNotReplacePending() {
        val buffer = AccountLinkBuffer()
        val valid = "https://example.invalid/otp#token=fixture"
        assertTrue(buffer.offer(valid))
        assertFalse(buffer.offer("http://example.invalid/otp#token=x"))
        assertFalse(buffer.offer("https://" + "x".repeat(40001)))
        assertEquals(valid, buffer.take())
        buffer.offer(valid)
        buffer.clear()
        assertNull(buffer.take())
    }
}
