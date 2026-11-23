package vn.sme.meetingassistant.sme_meeting_assistant

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import android.content.Context
import android.os.Handler
import android.os.HandlerThread

class MainActivity : FlutterActivity() {
    private var durabilityThread: HandlerThread? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

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

    override fun onDestroy() {
        durabilityThread?.quitSafely()
        durabilityThread = null
        super.onDestroy()
    }
}
