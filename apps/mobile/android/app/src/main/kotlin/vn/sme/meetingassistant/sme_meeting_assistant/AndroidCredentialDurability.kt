package vn.sme.meetingassistant.sme_meeting_assistant

import android.content.SharedPreferences

/**
 * Confirms writes made by flutter_secure_storage 11.2.0 have passed through
 * SharedPreferences' synchronous disk-commit path. The caller must run this on
 * a worker thread; no credential values enter this adapter.
 */
internal class AndroidCredentialDurability(
    private val openPreferences: (String) -> SharedPreferences,
) {
    fun confirmDurability() {
        try {
            for (name in backingPreferenceNames) {
                val preferences = openPreferences(name)
                val nextMarker = preferences
                    .getLong(durabilityMarkerKey, 0L)
                    .let { previous -> if (previous == Long.MAX_VALUE) Long.MIN_VALUE else previous + 1L }
                if (!preferences.edit().putLong(durabilityMarkerKey, nextMarker).commit()) {
                    throw CredentialDurabilityException()
                }
            }
        } catch (failure: CredentialDurabilityException) {
            throw failure
        } catch (_: Exception) {
            throw CredentialDurabilityException()
        }
    }

    companion object {
        const val channelName =
            "vn.sme.meetingassistant.sme_meeting_assistant/credential_durability"
        const val methodName = "confirmSecureStorageDurability"

        // These are the default identities in the pinned plugin configuration:
        // encrypted data, its RSA-wrapped AES key, namespaced cipher metadata,
        // and the read-only legacy metadata fallback.
        const val dataPreferences = "FlutterSecureStorage"
        const val keyStoragePreferences = "FlutterSecureKeyStorage"
        const val namespacedConfigurationPreferences =
            "FlutterSecureStorageConfiguration:FlutterSecureStorage"
        const val legacyConfigurationPreferences =
            "FlutterSecureStorageConfiguration"
        const val durabilityMarkerKey = "_sme_mobile_secure_storage_durable_v1"

        val backingPreferenceNames = listOf(
            dataPreferences,
            keyStoragePreferences,
            namespacedConfigurationPreferences,
            legacyConfigurationPreferences,
        )
    }
}

internal class CredentialDurabilityException : Exception(
    "Secure credential durability could not be confirmed.",
)
