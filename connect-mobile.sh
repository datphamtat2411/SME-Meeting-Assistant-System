#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$SCRIPT_DIR/apps/mobile"
PACKAGE_NAME="vn.sme.meetingassistant.sme_meeting_assistant"
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8080/api/v1}"
DEVICE_ID="${DEVICE_ID:-}"
API_PROXY_PID=""
API_PROXY_LOG=""
ACTIVE_DEVICE_ID=""
API_PROXY_OWNED=0
UPDATE_REQUESTED=0
APK_READY=0

for argument in "$@"; do
  case "$argument" in
    --update)
      UPDATE_REQUESTED=1
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: ./connect-mobile.sh [--update]

  --update  Build and install a fresh debug APK on the next connected device.

Without --update, an already-installed app is reused. The APK is built only
when the package is missing from the connected device.
USAGE
      exit 0
      ;;
    *)
      echo "Tham số không hợp lệ: $argument (dùng --update hoặc --help)." >&2
      exit 2
      ;;
  esac
done

if [[ "$API_BASE_URL" == "http://localhost:8080/api/v1" ]]; then
  API_BASE_URL="http://127.0.0.1:8080/api/v1"
fi

if [[ -z "${ADB_SERVER_SOCKET:-}" ]]; then
  WINDOWS_HOST="${WINDOWS_HOST:-$(ip route show default | awk 'NR == 1 {print $3}')}"
  if [[ -z "$WINDOWS_HOST" ]]; then
    echo "Không tìm thấy địa chỉ Windows host để kết nối ADB." >&2
    exit 1
  fi
  export ADB_SERVER_SOCKET="tcp:${WINDOWS_HOST}:5037"
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "Không tìm thấy adb trong PATH." >&2
  exit 1
fi

if command -v fvm >/dev/null 2>&1; then
  FLUTTER=(fvm flutter)
else
  FLUTTER=(flutter)
fi

cleanup() {
  if [[ -n "$ACTIVE_DEVICE_ID" ]]; then
    adb -s "$ACTIVE_DEVICE_ID" reverse --remove tcp:8080 >/dev/null 2>&1 || true
  fi
  if [[ "$API_PROXY_OWNED" == 1 && -n "$API_PROXY_PID" ]]; then
    kill "$API_PROXY_PID" 2>/dev/null || true
    wait "$API_PROXY_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT

start_api_proxy() {
  case "$API_BASE_URL" in
    http://127.0.0.1:8080/api/v1)
      ;;
    *)
      return
      ;;
  esac

  local wsl_ip="${WSL_IP:-$(ip -4 addr show eth0 | awk '/inet / {sub(/\/.*/, "", $2); print $2; exit}')}"
  local powershell="${POWERSHELL:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"
  local windows_netstat="${WINDOWS_NETSTAT:-/mnt/c/Windows/System32/netstat.exe}"

  if [[ -z "$wsl_ip" ]]; then
    echo "Không tìm thấy IPv4 của WSL2 để chuyển tiếp API." >&2
    exit 1
  fi
  if [[ ! -x "$powershell" ]]; then
    echo "Không tìm thấy Windows PowerShell để tạo proxy API." >&2
    exit 1
  fi
  if [[ ! -x "$windows_netstat" ]]; then
    echo "Không tìm thấy netstat.exe để kiểm tra proxy API." >&2
    exit 1
  fi

  if "$windows_netstat" -ano 2>/dev/null |
    grep '127.0.0.1:8080.*LISTENING' >/dev/null; then
    return
  fi

  mkdir -p /tmp/opencode
  API_PROXY_LOG="/tmp/opencode/mobile-api-proxy-${BASHPID}.log"
  local proxy_script
  proxy_script=$(cat <<EOF
\$ErrorActionPreference = 'Stop'
\$listener = [System.Net.Sockets.TcpListener]::new(
  [System.Net.IPAddress]::Parse('127.0.0.1'),
  8080
)
\$listener.Start()
try {
  while (\$true) {
    \$client = \$listener.AcceptTcpClient()
    try {
      \$upstream = [System.Net.Sockets.TcpClient]::new()
      \$upstream.Connect('$wsl_ip', 8080)
      \$clientStream = \$client.GetStream()
      \$upstreamStream = \$upstream.GetStream()
      \$clientToUpstream = \$clientStream.CopyToAsync(\$upstreamStream)
      \$upstreamToClient = \$upstreamStream.CopyToAsync(\$clientStream)
      [System.Threading.Tasks.Task]::WaitAny(
        [System.Threading.Tasks.Task[]]@(\$clientToUpstream, \$upstreamToClient)
      ) | Out-Null
    } catch {
    } finally {
      if (\$upstream) { \$upstream.Dispose() }
      if (\$client) { \$client.Dispose() }
    }
  }
} finally {
  \$listener.Stop()
}
EOF
)
  local proxy_command
  proxy_command=$(
    printf '%s' "$proxy_script" |
      iconv -f UTF-8 -t UTF-16LE |
      base64 -w0
  )
  nohup "$powershell" -NoProfile -NonInteractive \
    -EncodedCommand "$proxy_command" \
    >"$API_PROXY_LOG" 2>&1 </dev/null &
  API_PROXY_PID=$!
  API_PROXY_OWNED=1

  local proxy_ready=0
  for _ in {1..40}; do
    if "$windows_netstat" -ano 2>/dev/null |
      grep '127.0.0.1:8080.*LISTENING' >/dev/null; then
      proxy_ready=1
      break
    fi
    if ! kill -0 "$API_PROXY_PID" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  if [[ "$proxy_ready" != 1 ]]; then
    echo "Không khởi động được proxy IPv4 cho API." >&2
    [[ -f "$API_PROXY_LOG" ]] && cat "$API_PROXY_LOG" >&2
    exit 1
  fi
}

find_connected_device() {
  if [[ -n "$DEVICE_ID" ]]; then
    if adb -s "$DEVICE_ID" get-state 2>/dev/null | grep -qx device; then
      printf '%s\n' "$DEVICE_ID"
    fi
    return
  fi

  adb devices 2>/dev/null |
    awk '$2 == "device" {print $1; exit}'
}

wait_for_device() {
  local connected
  local announced=0
  while :; do
    connected="$(find_connected_device || true)"
    if [[ -n "$connected" ]]; then
      printf '%s\n' "$connected"
      return
    fi
    if [[ "$announced" == 0 ]]; then
      echo "Đang chờ điện thoại Android được cắm và cấp quyền ADB..." >&2
      announced=1
    fi
    sleep 2
  done
}

device_is_connected() {
  adb -s "$1" get-state 2>/dev/null | grep -qx device
}

launch_mobile_app() {
  adb -s "$1" shell monkey \
    -p "$PACKAGE_NAME" \
    -c android.intent.category.LAUNCHER \
    1 >/dev/null 2>&1
}

package_is_installed() {
  adb -s "$1" shell pm path "$PACKAGE_NAME" 2>/dev/null |
    grep -q '^package:'
}

build_apk() {
  if [[ "$APK_READY" == 1 ]]; then
    return
  fi

  echo "Đang build APK debug..."
  (
    cd "$MOBILE_DIR"
    "${FLUTTER[@]}" build apk --debug \
      "--dart-define=API_BASE_URL=$API_BASE_URL"
  )
  APK_READY=1
}

start_api_proxy

echo "ADB server: ${ADB_SERVER_SOCKET:-mặc định}"
echo "API_BASE_URL: $API_BASE_URL"

APK_PATH="$MOBILE_DIR/build/app/outputs/flutter-apk/app-debug.apk"

while :; do
  ACTIVE_DEVICE_ID="$(wait_for_device)"
  echo "Đã kết nối thiết bị: $ACTIVE_DEVICE_ID"

  needs_install=0
  if [[ "$UPDATE_REQUESTED" == 1 ]] ||
    ! package_is_installed "$ACTIVE_DEVICE_ID"; then
    needs_install=1
  fi

  if [[ "$needs_install" == 1 ]]; then
    if [[ "$UPDATE_REQUESTED" == 1 ]]; then
      echo "Đang cập nhật app theo yêu cầu --update..."
    else
      echo "Thiết bị chưa có app; chuẩn bị APK lần đầu..."
    fi
    if ! build_apk; then
      echo "Build APK thất bại; sẽ chờ kết nối lại." >&2
      ACTIVE_DEVICE_ID=""
      sleep 2
      continue
    fi
    if ! adb -s "$ACTIVE_DEVICE_ID" install -r "$APK_PATH"; then
      echo "Cài APK thất bại; sẽ chờ kết nối lại." >&2
      ACTIVE_DEVICE_ID=""
      sleep 2
      continue
    fi
    UPDATE_REQUESTED=0
  else
    echo "App đã có trên thiết bị; bỏ qua build và cài đặt."
  fi

  if ! adb -s "$ACTIVE_DEVICE_ID" reverse tcp:8080 tcp:8080; then
    echo "Không tạo được ADB reverse; sẽ chờ kết nối lại." >&2
    ACTIVE_DEVICE_ID=""
    sleep 2
    continue
  fi
  adb -s "$ACTIVE_DEVICE_ID" reverse --list

  if ! launch_mobile_app "$ACTIVE_DEVICE_ID"; then
    echo "Không mở được app mobile; sẽ chờ kết nối lại." >&2
    ACTIVE_DEVICE_ID=""
    sleep 2
    continue
  fi

  echo "App mobile đã được mở. Có thể đóng/mở lại app khi script vẫn đang chạy."
  while device_is_connected "$ACTIVE_DEVICE_ID"; do
    sleep 2
  done
  echo "Điện thoại đã ngắt kết nối; đang chờ cắm lại..."
  ACTIVE_DEVICE_ID=""
done
