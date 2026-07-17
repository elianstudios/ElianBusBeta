#!/bin/bash
# ElianBus — manual/foreground start (double-click). For always-on use the
# LaunchAgent instead:  cp com.elian.elianbus.plist ~/Library/LaunchAgents/ &&
#                       launchctl load ~/Library/LaunchAgents/com.elian.elianbus.plist
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")"
[ -d node_modules/ws ] || npm install
exec node hub.js
