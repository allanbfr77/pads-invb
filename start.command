#!/bin/bash
# Pads Igreja - inicia o servidor e abre o player com o áudio já ligado (macOS + Chrome)
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --omit=dev
node server.js &
SERVER=$!
trap "kill $SERVER 2>/dev/null" EXIT
sleep 2
open -na "Google Chrome" --args --user-data-dir="$PWD/chrome-profile" --autoplay-policy=no-user-gesture-required --app="http://localhost:3000/player?auto=1"
wait $SERVER
