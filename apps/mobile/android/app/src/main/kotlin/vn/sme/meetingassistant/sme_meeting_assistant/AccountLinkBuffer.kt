package vn.sme.meetingassistant.sme_meeting_assistant

/** Keep acquisition provenance without exposing the raw URL in toString(). */
internal class AccountLinkDelivery(val url: String, val initial: Boolean)

/** Main-thread owned, bounded raw delivery buffer. Dart owns trusted pending input. */
internal class AccountLinkBuffer {
    private val pending = ArrayDeque<AccountLinkDelivery>()

    fun offer(value: String, initial: Boolean): Boolean {
        if (value.length > maxUrlLength || !value.startsWith("https://", ignoreCase = true)) {
            return false
        }
        if (pending.any { it.url == value }) return false
        if (pending.size == maxPending) pending.removeFirst()
        pending.addLast(AccountLinkDelivery(value, initial))
        return true
    }

    fun take(): AccountLinkDelivery? = pending.removeFirstOrNull()

    fun clear() {
        pending.clear()
    }

    companion object {
        const val channelName = "sme/account_links"
        const val maxUrlLength = 40000
        const val maxPending = 4
    }
}
