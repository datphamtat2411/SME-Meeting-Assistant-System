import java.util.Properties
import java.util.Base64
import java.util.Locale

val releaseSigningProperties = Properties().apply {
    val propertiesFile = rootProject.file("key.properties")
    if (propertiesFile.isFile) {
        propertiesFile.inputStream().use(::load)
    }
}

fun String?.nonBlank(): String? = this?.trim()?.takeIf { it.isNotEmpty() }

fun releaseSigningValue(propertyName: String, environmentName: String): String? =
    System.getenv(environmentName).nonBlank()
        ?: releaseSigningProperties.getProperty(propertyName).nonBlank()

val releaseStoreFilePath =
    releaseSigningValue("storeFile", "ANDROID_RELEASE_STORE_FILE")
val releaseStorePassword =
    releaseSigningValue("storePassword", "ANDROID_RELEASE_STORE_PASSWORD")
val releaseKeyAlias =
    releaseSigningValue("keyAlias", "ANDROID_RELEASE_KEY_ALIAS")
val releaseKeyPassword =
    releaseSigningValue("keyPassword", "ANDROID_RELEASE_KEY_PASSWORD")
val releaseKeystoreFile = releaseStoreFilePath?.let(rootProject::file)
val releaseSigningValuesPresent = listOf(
    releaseStoreFilePath,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { it != null }

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

// Flutter passes --dart-define values through the dart-defines Gradle property.
// Use the same value in the manifest and Dart, never a second editable host.
val accountLinkHosts = (findProperty("dart-defines") as String?)
    .orEmpty().split(",").filter { it.isNotEmpty() }
    .map { String(Base64.getDecoder().decode(it), Charsets.UTF_8) }
    .filter { it.startsWith("ACCOUNT_LINK_HOST=") }
    .map { it.substringAfter("=") }
require(accountLinkHosts.size <= 1) { "Duplicate ACCOUNT_LINK_HOST configuration." }
val rawAccountLinkHost = accountLinkHosts.singleOrNull().orEmpty()
val accountLinkHost = rawAccountLinkHost.lowercase(Locale.ROOT)
if (rawAccountLinkHost.isNotEmpty()) {
    val labels = rawAccountLinkHost.split(".")
    val label = Regex("[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
    require(rawAccountLinkHost.length <= 253 && labels.size >= 2 &&
        labels.all { label.matches(it) } &&
        labels.last().any { it in 'a'..'z' || it in 'A'..'Z' }) {
        "Invalid ACCOUNT_LINK_HOST."
    }
}
val accountLinkFilters = if (accountLinkHost.isEmpty()) "" else
    listOf("/account-setup", "/reset-password", "/sign-up", "/otp").joinToString("\n") { path ->
        """
        <intent-filter android:autoVerify="true">
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="https" android:host="$accountLinkHost" android:path="$path" />
        </intent-filter>
        """.trimIndent()
    }
val accountLinkManifest = layout.buildDirectory.file("generated/accountLinks/AndroidManifest.xml").get().asFile
val manifestTemplate = file("src/main/AndroidManifest.xml").readText()
check(manifestTemplate.contains("<!-- ACCOUNT_LINK_FILTERS -->"))
val effectiveManifest = manifestTemplate.replace("<!-- ACCOUNT_LINK_FILTERS -->", accountLinkFilters)
// A generated main manifest avoids advertising a fake host in unconfigured builds.
accountLinkManifest.parentFile.mkdirs()
if (!accountLinkManifest.exists() || accountLinkManifest.readText() != effectiveManifest) {
    accountLinkManifest.writeText(effectiveManifest)
}

android {
    sourceSets.getByName("main").manifest.srcFile(accountLinkManifest)
    namespace = "vn.sme.meetingassistant.sme_meeting_assistant"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    signingConfigs {
        if (releaseSigningValuesPresent) {
            create("release") {
                keyAlias = requireNotNull(releaseKeyAlias)
                keyPassword = requireNotNull(releaseKeyPassword)
                storeFile = requireNotNull(releaseKeystoreFile)
                storePassword = requireNotNull(releaseStorePassword)
            }
        }
    }

    defaultConfig {
        applicationId = "vn.sme.meetingassistant.sme_meeting_assistant"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            if (releaseSigningValuesPresent) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

val validateReleaseSigning = tasks.register("validateReleaseSigning") {
    doLast {
        val missingInputs = mutableListOf<String>().apply {
            if (releaseStoreFilePath == null) {
                add("storeFile or ANDROID_RELEASE_STORE_FILE")
            }
            if (releaseStorePassword == null) {
                add("storePassword or ANDROID_RELEASE_STORE_PASSWORD")
            }
            if (releaseKeyAlias == null) {
                add("keyAlias or ANDROID_RELEASE_KEY_ALIAS")
            }
            if (releaseKeyPassword == null) {
                add("keyPassword or ANDROID_RELEASE_KEY_PASSWORD")
            }
        }
        if (releaseKeystoreFile != null && !releaseKeystoreFile.isFile) {
            missingInputs += "keystore file at ${releaseKeystoreFile.path}"
        }
        if (missingInputs.isNotEmpty()) {
            throw GradleException(
                "Release signing is required. Configure android/key.properties or " +
                    "ANDROID_RELEASE_* environment variables; missing/invalid: " +
                    missingInputs.joinToString(", "),
            )
        }
    }
}

tasks.configureEach {
    if (name.contains("Release", ignoreCase = true) &&
        name != validateReleaseSigning.name
    ) {
        dependsOn(validateReleaseSigning)
    }
}
