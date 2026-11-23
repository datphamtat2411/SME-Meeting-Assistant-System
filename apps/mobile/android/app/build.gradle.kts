import java.util.Properties

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

android {
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
