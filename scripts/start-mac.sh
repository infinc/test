#!/usr/bin/env bash
# Starts (optionally) WebDriverAgent, the iproxy port forwarding and the web server on a Mac.
# Written for macOS's default bash 3.2.
set -euo pipefail
cd "$(dirname "$0")/.."

env_value() {
  if [ -f .env ]; then sed -n "s/^$1=//p" .env | tail -n 1; fi
}

IPHONE_UDID="${IPHONE_UDID:-$(env_value IPHONE_UDID)}"
WDA_PROJECT_DIR="${WDA_PROJECT_DIR:-$(env_value WDA_PROJECT_DIR)}"
CLOUDFLARE_TUNNEL_NAME="${CLOUDFLARE_TUNNEL_NAME:-$(env_value CLOUDFLARE_TUNNEL_NAME)}"
WDA_PID=""
IPROXY_PID=""
TUNNEL_PID=""

cleanup() {
  if [ -n "$TUNNEL_PID" ]; then kill "$TUNNEL_PID" 2>/dev/null || true; fi
  if [ -n "$IPROXY_PID" ]; then kill "$IPROXY_PID" 2>/dev/null || true; fi
  if [ -n "$WDA_PID" ]; then kill "$WDA_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

if ! command -v iproxy >/dev/null 2>&1; then
  echo "iproxy が見つかりません。'brew install libimobiledevice' を実行してください" >&2
  exit 1
fi

if [ -n "$WDA_PROJECT_DIR" ]; then
  if [ -z "$IPHONE_UDID" ]; then
    echo "WDA_PROJECT_DIR を使う場合は IPHONE_UDID も設定してください(idevice_id -l で確認できます)" >&2
    exit 1
  fi
  echo "WebDriverAgent をビルドして iPhone で起動します(ログ: wda.log)..."
  xcodebuild -project "$WDA_PROJECT_DIR/WebDriverAgent.xcodeproj" \
    -scheme WebDriverAgentRunner \
    -destination "id=$IPHONE_UDID" \
    -allowProvisioningUpdates \
    test >wda.log 2>&1 &
  WDA_PID=$!
fi

if [ -n "$IPHONE_UDID" ]; then
  iproxy -u "$IPHONE_UDID" -s 127.0.0.1 8100:8100 9100:9100 >/dev/null 2>&1 &
else
  iproxy -s 127.0.0.1 8100:8100 9100:9100 >/dev/null 2>&1 &
fi
IPROXY_PID=$!
sleep 1
if ! kill -0 "$IPROXY_PID" 2>/dev/null; then
  echo "iproxy の起動に失敗しました。iPhone が USB で接続され「信頼」済みか確認してください" >&2
  exit 1
fi

echo "WebDriverAgent の応答を待っています..."
ready=""
for _ in $(seq 1 90); do
  if curl -fsS -m 2 http://127.0.0.1:8100/status >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  if [ -n "$WDA_PID" ] && ! kill -0 "$WDA_PID" 2>/dev/null; then
    echo "WebDriverAgent の起動に失敗しました。wda.log を確認してください" >&2
    exit 1
  fi
  sleep 2
done
if [ -z "$ready" ]; then
  echo "警告: WebDriverAgent が応答しません。サーバーは起動しますが、画面は「未接続」になります" >&2
fi

if [ -n "$CLOUDFLARE_TUNNEL_NAME" ]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared が見つかりません。'brew install cloudflared' を実行してください" >&2
    exit 1
  fi
  echo "Cloudflare Tunnel '$CLOUDFLARE_TUNNEL_NAME' を起動します(ログ: tunnel.log)..."
  cloudflared tunnel run "$CLOUDFLARE_TUNNEL_NAME" >tunnel.log 2>&1 &
  TUNNEL_PID=$!
fi

npm start
