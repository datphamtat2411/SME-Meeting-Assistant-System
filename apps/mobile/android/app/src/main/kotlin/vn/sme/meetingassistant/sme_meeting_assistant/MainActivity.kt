package vn.sme.meetingassistant.sme_meeting_assistant

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread

class MainActivity : FlutterActivity() {
    private val accountLinks get() = pendingAccountLinks
    private var accountLinkChannel: MethodChannel? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        val initial = intent
        // A recreated activity must not replay the original VIEW intent.
        // Undelivered process-local entries remain available to the new engine.
        if (savedInstanceState == null) captureAccountLink(initial, initial = true)
        if (initial.action == Intent.ACTION_VIEW) {
            setIntent(Intent(initial).setData(null))
        }
        super.onCreate(savedInstanceState)
    }

    override fun onNewIntent(intent: Intent) {
        captureAccountLink(intent, initial = false)
        val sanitized = if (intent.action == Intent.ACTION_VIEW) {
            Intent(intent).setData(null)
        } else intent
        super.onNewIntent(sanitized)
        setIntent(sanitized)
    }

    private fun captureAccountLink(intent: Intent?, initial: Boolean) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val url = intent.dataString ?: return
        if (accountLinks.offer(url, initial)) {
            accountLinkChannel?.invokeMethod("available", null)
        }
    }

    private var durabilityThread: HandlerThread? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        accountLinkChannel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            AccountLinkBuffer.channelName,
        ).also { channel ->
            channel.setMethodCallHandler { call, result ->
                if (call.method == "takePending" && call.arguments == null) {
                    result.success(accountLinks.take()?.let {
                        mapOf("url" to it.url, "initial" to it.initial)
                    })
                } else {
                    result.notImplemented()
                }
            }
        }

        val thread = HandlerThread("sme-credential-durability").apply { start() }
        durabilityThread = thread
        val worker = Handler(thread.looper)
        val adapter = AndroidCredentialDurability { name ->
            applicationContext.getSharedPreferences(name, Context.MODE_PRIVATE)
        }
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            AndroidCredentialDurability.channelName,
        ).setMethodCallHandler { call, result ->
            if (call.method != AndroidCredentialDurability.methodName) {
                result.notImplemented()
                return@setMethodCallHandler
            }
            if (call.arguments != null) {
                result.error(
                    "INVALID_DURABILITY_REQUEST",
                    "Credential durability requests do not accept values.",
                    null,
                )
                return@setMethodCallHandler
            }

            worker.post {
                try {
                    adapter.confirmDurability()
                    runOnUiThread { result.success(null) }
                } catch (_: CredentialDurabilityException) {
                    runOnUiThread {
                        result.error(
                            "DURABILITY_UNCONFIRMED",
                            "Secure credential durability could not be confirmed.",
                            null,
                        )
                    }
                }
            }
        }
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        accountLinkChannel?.setMethodCallHandler(null)
        accountLinkChannel = null
        if (!isChangingConfigurations) accountLinks.clear()
        super.cleanUpFlutterEngine(flutterEngine)
    }

    override fun onDestroy() {
        if (!isChangingConfigurations) accountLinks.clear()
        durabilityThread?.quitSafely()
        durabilityThread = null
        super.onDestroy()
    }

    companion object {
        private val pendingAccountLinks = AccountLinkBuffer()
    }
}
