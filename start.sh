#!/bin/bash
# RiffBank dev launcher — starts server + ngrok, prints phone URL
set -e

cd "$(dirname "$0")"

# Kill any existing instances
pkill -f "node server.js" 2>/dev/null || true
pkill -f "ngrok http" 2>/dev/null || true
sleep 0.5

echo "Starting RiffBank dev server..."
node server.js &
SERVER_PID=$!

echo "Starting ngrok tunnel..."
ngrok http 3000 --log=stdout --log-format=json > /tmp/ngrok-riffbank.log 2>&1 &
NGROK_PID=$!

# Wait for ngrok to come up and extract the public URL
echo "Waiting for ngrok URL..."
for i in $(seq 1 20); do
  URL=$(grep -o '"url":"https://[^"]*"' /tmp/ngrok-riffbank.log 2>/dev/null | head -1 | cut -d'"' -f4)
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
  echo "  ⚠️  ngrok URL not found — check /tmp/ngrok-riffbank.log"
fi

echo "  (Press Ctrl+C to stop everything)"
echo ""

# Keep running; kill both on exit
trap "kill $SERVER_PID $NGROK_PID 2>/dev/null; echo 'Stopped.'" EXIT
wait $SERVER_PID
