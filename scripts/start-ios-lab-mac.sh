#!/bin/bash

set -u

APPIUM_URL="${APPIUM_URL:-http://127.0.0.1:4723}"
TEAM_ID="8S3DQVA5N6"
SIGNING_ID="Apple Development"
BUNDLE_ID="com.integrationnet.WebDriverAgentRunner"

UDIDS=(
  "00008101-001220200CB8001E"
  "00008140-000231342129401C"
  "00008110-000668CA01B8801E"
  "00008112-001C718C017BA01E"
  "00008030-001C4DCC1EA0402E"
)

PORTS=(9200 9201 9202 9203 9204)

if ! curl -fsS "$APPIUM_URL/status" >/dev/null; then
  echo "Appium is not available at $APPIUM_URL" >&2
  exit 1
fi

for index in "${!UDIDS[@]}"; do
  udid="${UDIDS[$index]}"
  port="${PORTS[$index]}"
  echo "Starting WDA session for $udid"

  curl -fsS -X POST "$APPIUM_URL/session" \
    -H 'Content-Type: application/json' \
    -d "{\
      \"capabilities\": {\
        \"alwaysMatch\": {\
          \"platformName\": \"iOS\",\
          \"appium:automationName\": \"XCUITest\",\
          \"appium:udid\": \"$udid\",\
          \"appium:xcodeOrgId\": \"$TEAM_ID\",\
          \"appium:xcodeSigningId\": \"$SIGNING_ID\",\
          \"appium:updatedWDABundleId\": \"$BUNDLE_ID\",\
          \"appium:mjpegServerPort\": 9100,\
          \"appium:useNewWDA\": false,\
          \"appium:wdaLaunchTimeout\": 120000\
        },\
        \"firstMatch\": [{}]\
      }\
    }"

  echo

  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "iproxy already listening on $port"
    continue
  fi

  nohup iproxy -u "$udid" "$port:9100" \
    > "$HOME/iproxy-$port.log" 2>&1 &
  disown
  echo "iproxy started: localhost:$port -> device:$udid:9100"
done

printf '\nConfigured MJPEG ports:\n'
for index in "${!UDIDS[@]}"; do
  printf '  %s -> %s\n' "${UDIDS[$index]}" "${PORTS[$index]}"
done
