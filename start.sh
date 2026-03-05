#!/bin/bash
# RiffBank dev launcher — starts server + cloudflare tunnel, prints phone URL
set -e

cd "$(dirname "$0")"

# Kill any existing instances
pkill -f "node server.js" 2>/dev/null || true
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 0.5

echo "Starting RiffBank dev server..."
node server.js &
SERVER_PID=$!

echo "Starting Cloudflare tunnel..."
cloudflared tunnel --url http://localhost:3000 > /tmp/cloudflared-riffbank.log 2>&1 &
CF_PID=$!

# Wait for cloudflared to come up and extract the public URL
echo "Waiting for tunnel URL..."
for i in $(seq 1 30); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cloudflared-riffbank.log 2>/dev/null | head -1)
  if [ -n "$URL" ]; then
    echo ""
    echo "  ✅ RiffBank is live!"
    echo ""
    echo "  Local:  http://localhost:3000"
    echo "  Phone:  $URL"
    echo ""
    break
  fi
  sleep 0.5
done

if [ -z "$URL" ]; then
  echo "  ⚠️  Cloudflare tunnel URL not found — check /tmp/cloudflared-riffbank.log"
fi

echo "  (Press Ctrl+C to stop everything)"
echo ""

# Keep running; kill both on exit
trap "kill $SERVER_PID $CF_PID 2>/dev/null; echo 'Stopped.'" EXIT
wait $SERVER_PID
