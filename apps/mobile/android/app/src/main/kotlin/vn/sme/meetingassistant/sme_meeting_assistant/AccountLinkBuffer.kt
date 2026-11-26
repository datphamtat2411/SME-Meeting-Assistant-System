package vn.sme.meetingassistant.sme_meeting_assistant

/** Main-thread owned, bounded raw delivery buffer. Dart owns trusted pending input. */
internal class AccountLinkBuffer {
    private val pending = ArrayDeque<String>()

    fun offer(value: String): Boolean {
        if (value.length > maxUrlLength || !value.startsWith("https://", ignoreCase = true)) {
            return false
        }
        if (value in pending) return false
        if (pending.size == maxPending) pending.removeFirst()
        pending.addLast(value)
        return true
    }

    fun take(): String? = pending.removeFirstOrNull()

    fun clear() {
        pending.clear()
    }

    companion object {
        const val channelName = "sme/account_links"
        const val maxUrlLength = 40000
        const val maxPending = 4
    }
}
