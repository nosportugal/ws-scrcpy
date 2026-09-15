### Client

1. Build dev version (will include source maps):
> npm run dist:dev

2. Run from `dist` directory:
> npm run start

3. Use the browser's built-in developer tools or your favorite IDE.

### Node.js server

1. `npm run dist:dev`
2. `cd dist`
3. `node --inspect-brk ./index.js`

__HINT__: you might want to set `DEBUG` environment variable (see [debug](https://github.com/visionmedia/debug)):
> DEBUG=* node  --inspect-brk ./index.js

### Android server (`scrcpy-server.jar`)

### Remote iOS Appium/WDA

Run Appium with debug logging on the Mac mini:

> appium --address 0.0.0.0 --port 4723 --log-level debug

The Appium log should show one distinct `wdaLocalPort` per iOS UDID. The Ubuntu SSH tunnel only
needs Appium `4723` and MJPEG ports `9200` through `9204`; WDA ports `8100` through `8104` stay
local to the Mac mini.

Useful checks on Ubuntu:

> curl -sS http://127.0.0.1:4723/status
> curl -sS http://127.0.0.1:4723/sessions
> ss -ltn | grep -E '4723|9200|9201|9202|9203|9204'

If an Appium session exists but its WDA port returns `ECONNREFUSED`, the session is stale. ws-scrcpy
should remove and recreate only that device session. Do not remove all Appium sessions while another
iOS device is active.

Source code is available [here](https://github.com/NetrisTV/scrcpy/tree/feature/websocket-server)
__HINT__: you might want to build a dev version.

To debug the server:
1. start node server
2. kill server from UI (click button with cross and PID number).
3. upload server package to a device:
> adb push server/build/outputs/apk/debug/server-debug.apk /data/local/tmp/scrcpy-server.jar

4. setup port forwarding:
> adb forward tcp:5005 tcp:5005

5. connect to device with adb shell:
> adb shell

6.1. for Android 8 and below run this in adb shell (single line):
> CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process -agentlib:jdwp=transport=dt_socket,suspend=y,server=y,address=5005 / com.genymobile.scrcpy.Server 1.17-ws5 DEBUG web 8886

6.2. for Android 9 and above:
>  CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process -XjdwpProvider:internal -XjdwpOptions:transport=dt_socket,suspend=y,server=y,address=5005 / com.genymobile.scrcpy.Server 1.17-ws5 web DEBUG 8886

7. Open project (scrcpy, not ws-scrcpy) in Android Studio, create `Remote` Debug configuration with:
> Host: localhost, Port: 5005

Connect the debugger to the remote server on the device.
