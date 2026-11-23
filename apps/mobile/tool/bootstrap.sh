#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

die() {
    echo "Bootstrap failed: $*" >&2
    exit 1
}

FVM_BIN="${FVM_BIN:-fvm}"
command -v "$FVM_BIN" >/dev/null 2>&1 ||
    die "FVM is required. Install it with 'dart pub global activate fvm' and ensure it is on PATH."

[[ -f .fvmrc ]] || die "Missing .fvmrc project toolchain pin."
PINNED_FLUTTER="$(
    python3 - <<'PY'
import json
from pathlib import Path

config = json.loads(Path(".fvmrc").read_text())
version = config.get("flutter")
if not isinstance(version, str) or not version:
    raise SystemExit("The .fvmrc flutter version is missing.")
print(version)
PY
)" || die "Could not read the Flutter version from .fvmrc."

[[ "$PINNED_FLUTTER" == "3.50.1" ]] ||
    die "Expected Flutter 3.50.1 in .fvmrc, found '$PINNED_FLUTTER'."

java_major() {
    "$1/bin/java" -version 2>&1 |
        sed -nE 's/.*version "([0-9]+).*/\1/p' |
        head -n 1
}

if [[ -n "${JAVA_HOME:-}" ]]; then
    [[ "$(java_major "$JAVA_HOME")" == "17" ]] ||
        die "JAVA_HOME must point to JDK 17."
else
    java_candidates=()
    if [[ "$(uname -s)" == "Darwin" ]] &&
        command -v /usr/libexec/java_home >/dev/null 2>&1; then
        java_candidates+=("$(
            /usr/libexec/java_home -v 17 2>/dev/null || true
        )")
    fi
    java_candidates+=(
        "/usr/lib/jvm/java-17-openjdk-amd64"
        "/usr/lib/jvm/java-17-openjdk"
        "/usr/lib/jvm/jdk-17"
    )
    if command -v java >/dev/null 2>&1; then
        java_bin="$(readlink -f "$(command -v java)" 2>/dev/null || true)"
        if [[ "$java_bin" == */bin/java ]]; then
            java_candidates+=("${java_bin%/bin/java}")
        fi
    fi

    for candidate in "${java_candidates[@]}"; do
        if [[ -n "$candidate" && -x "$candidate/bin/java" ]] &&
            [[ "$(java_major "$candidate")" == "17" ]]; then
            export JAVA_HOME="$candidate"
            break
        fi
    done
    [[ -n "${JAVA_HOME:-}" ]] ||
        die "JDK 17 is required. Set JAVA_HOME to a JDK 17 installation."
fi
export PATH="$JAVA_HOME/bin:$PATH"

echo "Using Flutter $PINNED_FLUTTER through FVM."
"$FVM_BIN" install "$PINNED_FLUTTER"

flutter_version_output="$("$FVM_BIN" flutter --version)"
flutter_version="$(
    printf '%s\n' "$flutter_version_output" |
        sed -n 's/^Flutter \([^ ]*\).*/\1/p' |
        head -n 1
)"
[[ "$flutter_version" == "$PINNED_FLUTTER" ]] ||
    die "FVM resolved Flutter $flutter_version instead of $PINNED_FLUTTER."

dart_version="$(
    "$FVM_BIN" dart --version 2>&1 |
        sed -n 's/^Dart SDK version: \([^ ]*\).*/\1/p' |
        head -n 1
)"
[[ "$dart_version" == "3.14.0" ]] ||
    die "Flutter $PINNED_FLUTTER must bundle Dart 3.14.0, found '$dart_version'."

echo "Using JDK $(java -version 2>&1 | sed -nE 's/.*version "([^"]+).*/\1/p' | head -n 1)."
"$FVM_BIN" flutter pub get --enforce-lockfile
python3 tool/validate_native_config.py

echo "Flutter dependencies and committed Android configuration are ready."
