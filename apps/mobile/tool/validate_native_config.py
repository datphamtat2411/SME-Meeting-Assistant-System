#!/usr/bin/env python3
"""Validate Android platform and pinned toolchain invariants without modifying files."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


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
        "KeychainAccessibility.unlocked_this_device",
        "synchronizable: false",
    ):
        if required not in secure_storage:
            fail(f"secure credential configuration is missing {required}")

    expected_exclusions = {
        "FlutterSecureStorage.xml",
        "FlutterSecureKeyStorage.xml",
        "FlutterSecureStorageConfiguration:FlutterSecureStorage.xml",
        "FlutterSecureStorageConfiguration.xml",
    }
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
        )
    except OSError:
        result = None
    if result is not None and result.returncode == 0:
        fail("android/key.properties must not be tracked")


def main() -> int:
    validate_toolchain()
    validate_android()
    validate_bootstrap()
    validate_ignored_signing_files()

    if errors:
        print("Android configuration validation: FAIL")
        for error in errors:
            print(f"- {error}")
        return 1

    print("Android configuration validation: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
