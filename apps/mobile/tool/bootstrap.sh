#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
command -v flutter >/dev/null || { echo "Flutter SDK is required." >&2; exit 1; }

# Native runners are generated using the current Flutter SDK template.
flutter create --project-name sme_meeting_assistant --org vn.sme.meetingassistant --platforms=android,ios --no-pub .

# Reconcile the microphone permission/usage descriptions idempotently.
python3 - <<'PY'
from pathlib import Path

manifest = Path("android/app/src/main/AndroidManifest.xml")
if manifest.exists():
    text = manifest.read_text()
    for permission in ("android.permission.RECORD_AUDIO", "android.permission.INTERNET"):
        if permission not in text:
            text = text.replace("<application", f'<uses-permission android:name="{permission}" />\n    <application', 1)
    manifest.write_text(text)

debug = Path("android/app/src/debug/AndroidManifest.xml")
if debug.exists():
    text = debug.read_text()
    if "usesCleartextTraffic" not in text:
        if "<application" in text:
            text = text.replace("<application", '<application android:usesCleartextTraffic="true"', 1)
        else:
            text = text.replace("</manifest>", '    <application android:usesCleartextTraffic="true" />\n</manifest>', 1)
        debug.write_text(text)

plist = Path("ios/Runner/Info.plist")
if plist.exists():
    text = plist.read_text()
    if "NSMicrophoneUsageDescription" not in text:
        text = text.replace("</dict>", """    <key>NSMicrophoneUsageDescription</key>
    <string>Allow SME Meeting Assistant to record audio when you explicitly start a meeting recording.</string>
</dict>""", 1)
        plist.write_text(text)
PY

flutter pub get
echo "Platform runners and dependencies are ready."
