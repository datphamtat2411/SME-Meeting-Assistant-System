package vn.sme.meetingassistant.sme_meeting_assistant

import org.junit.Assert.*
import org.junit.Test

class AccountLinkBufferTest {
    @Test fun pendingEntriesAreConsumedOnceWithoutDecoding() {
        val buffer = AccountLinkBuffer()
        val first = "https://example.invalid/otp#token=first"
        val latest = "https://example.invalid/otp#token=a%2Bb"
        assertTrue(buffer.offer(first))
        assertFalse(buffer.offer(first))
        assertTrue(buffer.offer(latest))
        assertEquals(first, buffer.take())
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

    @Test fun rawDeliveryBufferHasDeterministicBoundedOverflow() {
        val buffer = AccountLinkBuffer()
        repeat(AccountLinkBuffer.maxPending + 1) {
            buffer.offer("https://example.invalid/otp#token=fixture$it")
        }
        for (index in 1..AccountLinkBuffer.maxPending) {
            assertEquals("https://example.invalid/otp#token=fixture$index", buffer.take())
        }
        assertNull(buffer.take())
    }
}
