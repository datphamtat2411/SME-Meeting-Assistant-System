package vn.sme.meetingassistant.sme_meeting_assistant

/** Main-thread owned, single-use delivery slot. No persistence or URL logging. */
internal class AccountLinkBuffer {
    private var pending: String? = null

    fun offer(value: String): Boolean {
        if (value.length > maxUrlLength || !value.startsWith("https://", ignoreCase = true)) {
            return false
        }
        pending = value
        return true
    }

    fun take(): String? = pending.also { pending = null }

    fun clear() {
        pending = null
    }

    companion object {
        const val channelName = "sme/account_links"
        const val maxUrlLength = 40000
    }
}
