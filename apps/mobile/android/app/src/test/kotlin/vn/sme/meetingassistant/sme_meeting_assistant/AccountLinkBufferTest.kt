package vn.sme.meetingassistant.sme_meeting_assistant

import org.junit.Assert.*
import org.junit.Test

class AccountLinkBufferTest {
    @Test fun pendingEntriesAreConsumedOnceWithoutDecoding() {
        val buffer = AccountLinkBuffer()
        val first = "https://example.invalid/otp#token=first"
        val latest = "https://example.invalid/otp#token=a%2Bb"
        assertTrue(buffer.offer(first, initial = true))
        assertFalse(buffer.offer(first, initial = false))
        assertTrue(buffer.offer(latest, initial = false))
        val initial = buffer.take()!!
        assertEquals(first, initial.url)
        assertTrue(initial.initial)
        val subsequent = buffer.take()!!
        assertEquals(latest, subsequent.url)
        assertFalse(subsequent.initial)
        assertNull(buffer.take())
    }

    @Test fun unsupportedOrOversizedInputDoesNotReplacePending() {
        val buffer = AccountLinkBuffer()
        val valid = "https://example.invalid/otp#token=fixture"
        assertTrue(buffer.offer(valid, initial = false))
        assertFalse(buffer.offer("http://example.invalid/otp#token=x", initial = false))
        assertFalse(buffer.offer("https://" + "x".repeat(40001), initial = false))
        val delivery = buffer.take()!!
        assertEquals(valid, delivery.url)
        assertFalse(delivery.initial)
        buffer.offer(valid, initial = false)
        buffer.clear()
        assertNull(buffer.take())
    }

    @Test fun rawDeliveryBufferHasDeterministicBoundedOverflow() {
        val buffer = AccountLinkBuffer()
        repeat(AccountLinkBuffer.maxPending + 1) {
            buffer.offer("https://example.invalid/otp#token=fixture$it", initial = it == 0)
        }
        for (index in 1..AccountLinkBuffer.maxPending) {
            val delivery = buffer.take()!!
            assertEquals("https://example.invalid/otp#token=fixture$index", delivery.url)
            assertFalse(delivery.initial)
        }
        assertNull(buffer.take())
    }
}
