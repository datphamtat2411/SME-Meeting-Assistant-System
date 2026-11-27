#!/usr/bin/env python3
"""Check actual merged Android App Links filters, not the source template."""

from __future__ import annotations

import argparse
import xml.etree.ElementTree as ET

from pathlib import Path

try:
    from .run_android_native_verification import ANDROID_NS, MANIFEST_CANDIDATES, ROOT
except ImportError:
    from run_android_native_verification import ANDROID_NS, MANIFEST_CANDIDATES, ROOT

APP_ID = "vn.sme.meetingassistant.sme_meeting_assistant"
PATHS = {"/account-setup", "/reset-password", "/sign-up", "/otp"}


def validate_account_link_manifest(root: Path, host: str | None) -> None:
    manifest = next(
        (root / relative for relative in MANIFEST_CANDIDATES
         if (root / relative).is_file()),
        None,
    )
    if manifest is None:
        raise ValueError("Effective merged debug manifest is missing.")

    def attr(element: ET.Element, name: str) -> str | None:
        return element.get(f"{{{ANDROID_NS}}}{name}")

    xml = ET.parse(manifest).getroot()
    application = xml.find("application")
    if xml.get("package") != APP_ID or application is None:
        raise ValueError("Unexpected application identity.")
    activities = [
        activity for activity in application.findall("activity")
        if attr(activity, "name") in {".MainActivity", APP_ID + ".MainActivity"}
    ]
    if len(activities) != 1:
        raise ValueError("Expected exactly one MainActivity.")
    activity = activities[0]
    metadata = [
        meta for meta in activity.findall("meta-data")
        if attr(meta, "name") == "flutter_deeplinking_enabled"
    ]
    if len(metadata) != 1 or attr(metadata[0], "value") != "false":
        raise ValueError("Default Flutter deep-link delivery must be disabled.")
    observed = []
    for intent in activity.findall("intent-filter"):
        actions = {attr(item, "name") for item in intent.findall("action")}
        categories = {attr(item, "name") for item in intent.findall("category")}
        if "android.intent.action.VIEW" not in actions:
            continue
        data = intent.findall("data")
        if (
            not host
            or attr(intent, "autoVerify") != "true"
            or actions != {"android.intent.action.VIEW"}
            or categories != {
                "android.intent.category.DEFAULT",
                "android.intent.category.BROWSABLE",
            }
            or len(data) != 1
        ):
            raise ValueError("Unexpected Android account-link filter.")
        attributes = {
            key.removeprefix(f"{{{ANDROID_NS}}}"): value
            for key, value in data[0].attrib.items()
        }
        if attributes != {
            "scheme": "https", "host": host.lower(),
            "path": attributes.get("path"),
        } or attributes.get("path") not in PATHS:
            raise ValueError("Android account-link filter is not narrowly scoped.")
        observed.append(attributes["path"])
    if len(observed) != len(set(observed)) or set(observed) != (PATHS if host else set()):
        raise ValueError("Missing or duplicate account-link callback filters.")
    print("Effective account-link manifest validation: PASS")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=None)
    args = parser.parse_args()
    try:
        validate_account_link_manifest(ROOT, args.host)
    except (ValueError, OSError, ET.ParseError) as error:
        print(f"Account-link manifest verification failed: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
