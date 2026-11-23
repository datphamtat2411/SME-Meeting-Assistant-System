#!/usr/bin/env python3
"""Validate Android platform and pinned toolchain invariants without modifying files."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parents[1]
ANDROID_NS = "http://schemas.android.com/apk/res/android"
ANDROID_APP_ID = "vn.sme.meetingassistant.sme_meeting_assistant"

errors: list[str] = []


def fail(message: str) -> None:
    errors.append(message)


def read(path: str) -> str:
    file = ROOT / path
    if not file.is_file():
        fail(f"missing {path}")
        return ""
    return file.read_text()


def android_attribute(element: ET.Element, name: str) -> str | None:
    return element.attrib.get(f"{{{ANDROID_NS}}}{name}")


def parse_xml(path: str) -> ET.Element | None:
    try:
        return ET.fromstring(read(path))
    except (ET.ParseError, ValueError) as error:
        fail(f"{path} is not valid XML: {error}")
        return None


def validate_toolchain() -> None:
    try:
        fvmrc = json.loads(read(".fvmrc"))
    except json.JSONDecodeError as error:
        fail(f".fvmrc is not valid JSON: {error}")
        fvmrc = {}
    if fvmrc.get("flutter") != "3.50.1":
        fail(".fvmrc must pin Flutter 3.50.1")

    pubspec = read("pubspec.yaml")
    if not re.search(r"sdk:\s*['\"]>=3\.14\.0 <4\.0\.0['\"]", pubspec):
        fail("pubspec.yaml must require Dart >=3.14.0 <4.0.0")

    lockfile = read("pubspec.lock")
    if not re.search(r"dart:\s*['\"]>=3\.14\.0 <4\.0\.0['\"]", lockfile):
        fail("pubspec.lock must resolve against Dart >=3.14.0 <4.0.0")

    settings = read("android/settings.gradle.kts")
    for plugin, version in (
        ("com.android.application", "9.3.1"),
        ("org.jetbrains.kotlin.android", "2.4.20"),
    ):
        if f'id("{plugin}") version "{version}"' not in settings:
            fail(f"Android settings must use {plugin} {version}")

    wrapper = read("android/gradle/wrapper/gradle-wrapper.properties")
    if "gradle-9.5.0-all.zip" not in wrapper:
        fail("Gradle Wrapper must use Gradle 9.5.0")

    gradle_properties = read("android/gradle.properties")
    for setting in ("android.newDsl=false", "android.builtInKotlin=false"):
        if setting not in gradle_properties:
            fail(f"Android legacy compatibility setting {setting} is missing")


def validate_android() -> None:
    app_gradle = read("android/app/build.gradle.kts")
    for required in (
        "JavaVersion.VERSION_17",
        "JavaLanguageVersion.of(17)",
        "JvmTarget.JVM_17",
        f'applicationId = "{ANDROID_APP_ID}"',
        "key.properties",
        "ANDROID_RELEASE_STORE_FILE",
        "ANDROID_RELEASE_STORE_PASSWORD",
        "ANDROID_RELEASE_KEY_ALIAS",
        "ANDROID_RELEASE_KEY_PASSWORD",
        "validateReleaseSigning",
    ):
        if required not in app_gradle:
            fail(f"android/app/build.gradle.kts is missing {required}")
    if re.search(r"signingConfig\s*=\s*signingConfigs\.getByName\(\"debug\"\)", app_gradle):
        fail("Android release must not use the debug signing configuration")

    main = parse_xml("android/app/src/main/AndroidManifest.xml")
    debug = parse_xml("android/app/src/debug/AndroidManifest.xml")
    profile = parse_xml("android/app/src/profile/AndroidManifest.xml")
    if main is not None:
        permissions = {
            android_attribute(permission, "name")
            for permission in main.findall("uses-permission")
        }
        for required_permission in (
            "android.permission.RECORD_AUDIO",
            "android.permission.INTERNET",
        ):
            if required_permission not in permissions:
                fail(f"Android main manifest is missing {required_permission}")
        application = main.find("application")
        if application is None:
            fail("Android main manifest is missing application")
        else:
            if android_attribute(application, "label") != "SME Meeting Assistant":
                fail("Android application label must be SME Meeting Assistant")
            if android_attribute(application, "usesCleartextTraffic") == "true":
                fail("Android cleartext traffic must not be enabled in the main manifest")
            if android_attribute(application, "allowBackup") != "true":
                fail("Android must keep backup enabled with targeted secure-storage exclusions")
            if android_attribute(application, "fullBackupContent") != "@xml/backup_rules":
                fail("Android legacy backup rules must be configured")
            if android_attribute(application, "dataExtractionRules") != "@xml/data_extraction_rules":
                fail("Android cloud/device-transfer rules must be configured")

    secure_storage = read("lib/core/credential_storage.dart")
    for required in (
        "resetOnError: false",
        "KeyCipherAlgorithm.RSA_ECB_OAEPwithSHA_256andMGF1Padding",
        "StorageCipherAlgorithm.AES_GCM_NoPadding",
    ):
        if required not in secure_storage:
            fail(f"secure credential configuration is missing {required}")

    expected_exclusions = secure_storage_backup_files()
    backup_rules = parse_xml("android/app/src/main/res/xml/backup_rules.xml")
    if backup_rules is not None:
        exclusions = {
            element.attrib.get("path")
            for element in backup_rules.findall("exclude")
            if element.attrib.get("domain") == "sharedpref"
        }
        if exclusions != expected_exclusions:
            fail("Android legacy backup rules must exclude all secure-storage files")

    extraction_rules = parse_xml(
        "android/app/src/main/res/xml/data_extraction_rules.xml"
    )
    if extraction_rules is not None:
        for rule_name in ("cloud-backup", "device-transfer"):
            section = extraction_rules.find(rule_name)
            exclusions = (
                {
                    element.attrib.get("path")
                    for element in section.findall("exclude")
                    if element.attrib.get("domain") == "sharedpref"
                }
                if section is not None
                else set()
            )
            if exclusions != expected_exclusions:
                fail(f"Android {rule_name} must exclude all secure-storage files")

    if debug is not None:
        application = debug.find("application")
        if application is None or android_attribute(application, "usesCleartextTraffic") != "true":
            fail("Android debug manifest must explicitly allow controlled cleartext traffic")

    if profile is not None:
        application = profile.find("application")
        if application is not None and android_attribute(application, "usesCleartextTraffic") == "true":
            fail("Android profile manifest must not enable debug cleartext traffic")

def secure_storage_backup_files() -> set[str]:
    lockfile = read("pubspec.lock")
    lockfile_lines = lockfile.splitlines()
    package_start = next(
        (
            index
            for index, line in enumerate(lockfile_lines)
            if line == "  flutter_secure_storage:"
        ),
        None,
    )
    package_lines = []
    if package_start is not None:
        for line in lockfile_lines[package_start + 1 :]:
            if re.fullmatch(r"  [A-Za-z0-9_]+:", line):
                break
            package_lines.append(line)
    if '    version: "11.2.0"' not in package_lines:
        fail("flutter_secure_storage must remain pinned to 11.2.0")
        return set()

    config_path = ROOT / ".dart_tool/package_config.json"
    try:
        package_config = json.loads(config_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot resolve pinned secure-storage Android sources: {error}")
        return set()

    package = next(
        (
            item
            for item in package_config.get("packages", [])
            if item.get("name") == "flutter_secure_storage"
        ),
        None,
    )
    if package is None:
        fail("flutter_secure_storage is missing from the resolved package config")
        return set()
    root_uri = package.get("rootUri", "")
    parsed_root = urlparse(root_uri)
    package_root = (
        Path(unquote(parsed_root.path))
        if parsed_root.scheme == "file"
        else (config_path.parent / root_uri).resolve()
    )

    config_source = package_root / (
        "android/src/main/java/com/it_nomads/fluttersecurestorage/"
        "FlutterSecureStorageConfig.java"
    )
    namespace_source = package_root / (
        "android/src/main/java/com/it_nomads/fluttersecurestorage/"
        "NamespacedConfigSource.java"
    )
    if not config_source.is_file() or not namespace_source.is_file():
        fail("pinned secure-storage Android backing-file implementation is missing")
        return set()
    config_text = config_source.read_text()
    namespace_text = namespace_source.read_text()

    default_data = re.search(
        r'DEFAULT_PREF_NAME\s*=\s*"([^"]+)"', config_text
    )
    key_name_source = config_text[
        config_text.find("getEffectiveKeyStoragePrefsName") :
    ]
    default_key = re.search(r':\s*"([^"]+)"\s*;', key_name_source)
    namespaced_config = re.search(
        r'return\s+"([^"]+):"\s*\+\s*sharedPreferencesName',
        namespace_text,
    )
    legacy_config = re.search(
        r'LEGACY_GLOBAL_CONFIG_NAME\s*=\s*"([^"]+)"',
        namespace_text,
    )
    if any(
        item is None
        for item in (default_data, default_key, namespaced_config, legacy_config)
    ):
        fail("could not derive secure-storage backing files from the pinned plugin")
        return set()

    data_name = default_data.group(1)
    native = read(
        "android/app/src/main/kotlin/vn/sme/meetingassistant/"
        "sme_meeting_assistant/AndroidCredentialDurability.kt"
    )
    configured_files = {
        name: re.search(
            rf"const val {constant}\s*=\s*\"([^\"]+)\"",
            native,
        )
        for name, constant in (
            ("data", "dataPreferences"),
            ("key", "keyStoragePreferences"),
            ("configuration", "namespacedConfigurationPreferences"),
            ("legacy", "legacyConfigurationPreferences"),
        )
    }
    if any(value is None for value in configured_files.values()):
        fail("Android durability adapter does not define every secure-storage file")
        return set()

    expected_names = {
        "data": data_name,
        "key": default_key.group(1),
        "configuration": namespaced_config.group(1) + ":" + data_name,
        "legacy": legacy_config.group(1),
    }
    for role, expected in expected_names.items():
        configured = configured_files[role]
        if configured is not None and configured.group(1) != expected:
            fail(
                f"Android durability {role} preference identity does not match "
                "flutter_secure_storage 11.2.0"
            )
    return {f"{name}.xml" for name in expected_names.values()}


def validate_bootstrap() -> None:
    bootstrap = read("tool/bootstrap.sh")
    if "flutter create" in bootstrap.lower():
        fail("tool/bootstrap.sh must not regenerate native projects")
    if "write_text" in bootstrap:
        fail("tool/bootstrap.sh must not rewrite native source files")
    if "flutter pub get --enforce-lockfile" not in bootstrap:
        fail("tool/bootstrap.sh must enforce the committed dependency lockfile")


def validate_ignored_signing_files() -> None:
    android_gitignore = read("android/.gitignore")
    for ignored in ("key.properties", "*.keystore", "*.jks"):
        if ignored not in android_gitignore:
            fail(f"android/.gitignore must ignore {ignored}")

    try:
        result = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "apps/mobile/android/key.properties"],
            cwd=ROOT.parent.parent,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        fail("timed out while checking that android/key.properties is untracked")
        result = None
    except OSError:
        fail("could not verify whether android/key.properties is tracked")
        result = None
    if result is not None and result.returncode == 0:
        fail("android/key.properties must not be tracked")


def main() -> int:
    validate_toolchain()
    validate_android()
    validate_bootstrap()
    validate_ignored_signing_files()

    if errors:
        print("Static Android configuration validation: FAIL")
        for error in errors:
            print(f"- {error}")
        return 1

    print("Static Android configuration validation: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
