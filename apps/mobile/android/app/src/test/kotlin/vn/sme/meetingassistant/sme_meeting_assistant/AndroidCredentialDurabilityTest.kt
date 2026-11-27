package vn.sme.meetingassistant.sme_meeting_assistant

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidCredentialDurabilityTest {
    @Test
    fun confirmSynchronouslyCommitsEverySecureStorageBackingFile() {
        val openedFiles = mutableListOf<String>()
        val preferences = mutableMapOf<String, FakeSharedPreferences>()
        val adapter = AndroidCredentialDurability { name ->
            openedFiles += name
            preferences.getOrPut(name) { FakeSharedPreferences() }
        }

        adapter.confirmDurability()

        assertEquals(AndroidCredentialDurability.backingPreferenceNames, openedFiles)
        assertEquals(
            AndroidCredentialDurability.backingPreferenceNames.toSet(),
            preferences.keys,
        )
        preferences.values.forEach { file ->
            assertEquals(1, file.commitCalls)
            assertEquals(0, file.applyCalls)
            assertEquals(
                setOf(AndroidCredentialDurability.durabilityMarkerKey),
                file.values.keys,
            )
            assertTrue(file.values.values.single() is Long)
        }
    }

    @Test
    fun falseCommitResultFailsDurabilityConfirmation() {
        val openedFiles = mutableListOf<String>()
        val adapter = AndroidCredentialDurability { name ->
            openedFiles += name
            FakeSharedPreferences(commitResult = name != AndroidCredentialDurability.keyStoragePreferences)
        }

        assertThrows(CredentialDurabilityException::class.java) {
            adapter.confirmDurability()
        }

        assertEquals(
            AndroidCredentialDurability.backingPreferenceNames.take(2),
            openedFiles,
        )
    }

    @Test
    fun adapterRequestsThePinnedSecureStorageDataAndMetadataFiles() {
        assertEquals(
            listOf(
                "FlutterSecureStorage",
                "FlutterSecureKeyStorage",
                "FlutterSecureStorageConfiguration:FlutterSecureStorage",
                "FlutterSecureStorageConfiguration",
            ),
            AndroidCredentialDurability.backingPreferenceNames,
        )
        assertFalse(
            AndroidCredentialDurability.backingPreferenceNames.any {
                it.contains("token", ignoreCase = true) ||
                    it.contains("credential", ignoreCase = true)
            },
        )
    }
}

private class FakeSharedPreferences(
    private val commitResult: Boolean = true,
) : SharedPreferences {
    val values = mutableMapOf<String, Any>()
    var commitCalls = 0
    var applyCalls = 0

    override fun getAll(): MutableMap<String, *> = values.toMutableMap()
    override fun getString(key: String, defValue: String?): String? =
        values[key] as? String ?: defValue
    override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? =
        @Suppress("UNCHECKED_CAST")
        (values[key] as? Set<String>)?.toMutableSet() ?: defValues
    override fun getInt(key: String, defValue: Int): Int = values[key] as? Int ?: defValue
    override fun getLong(key: String, defValue: Long): Long = values[key] as? Long ?: defValue
    override fun getFloat(key: String, defValue: Float): Float = values[key] as? Float ?: defValue
    override fun getBoolean(key: String, defValue: Boolean): Boolean =
        values[key] as? Boolean ?: defValue
    override fun contains(key: String): Boolean = values.containsKey(key)
    override fun edit(): SharedPreferences.Editor = FakeEditor()
    override fun registerOnSharedPreferenceChangeListener(
        listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(
        listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) = Unit

    private inner class FakeEditor : SharedPreferences.Editor {
        private val writes = mutableMapOf<String, Any?>()
        private var clear = false

        override fun putString(key: String, value: String?): SharedPreferences.Editor = put(key, value)
        override fun putStringSet(
            key: String,
            values: MutableSet<String>?,
        ): SharedPreferences.Editor = put(key, values?.toSet())
        override fun putInt(key: String, value: Int): SharedPreferences.Editor = put(key, value)
        override fun putLong(key: String, value: Long): SharedPreferences.Editor = put(key, value)
        override fun putFloat(key: String, value: Float): SharedPreferences.Editor = put(key, value)
        override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = put(key, value)
        override fun remove(key: String): SharedPreferences.Editor = put(key, null)
        override fun clear(): SharedPreferences.Editor {
            clear = true
            return this
        }

        override fun commit(): Boolean {
            commitCalls++
            if (clear) values.clear()
            writes.forEach { (key, value) ->
                if (value == null) values.remove(key) else values[key] = value
            }
            return commitResult
        }

        override fun apply() {
            applyCalls++
            commit()
        }

        private fun put(key: String, value: Any?): SharedPreferences.Editor {
            writes[key] = value
            return this
        }
    }
}
