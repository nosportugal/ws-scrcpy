# Architecture

## Runtime overview

```text
Browser
  |
  | WebSocket: ws-scrcpy control and MJPEG proxy requests
  v
Ubuntu / ws-scrcpy
  |\
  | \ SSH tunnel: Appium 4723 and MJPEG 9200-9204
  |  \
  v   v
Mac mini / Appium 2 + XCUITest
  |
  | One Appium session per iPhone/iPad
  | WDA local ports: 8100-8104
  | WDA MJPEG device port: 9100
  v
iOS devices
```

## iOS session lifecycle

The iOS path is lazy: no Appium session is required just to render the device list. A session is
created when the device is opened in the WebGUI.

1. The browser opens the iOS WDA WebSocket with the UDID in the URL.
2. The shared device lock marks that UDID as busy and rejects a second WebSocket for it.
3. `WdaRunner` finds an existing Appium session for the UDID.
4. A healthy session/WDA is reused; a stale session is deleted and recreated.
5. Appium starts or reuses WDA on the per-device `wdaLocalPort`.
6. MJPEG is proxied through the configured per-device `mjpegLocalPort`.
7. Closing the browser stream releases the WebSocket lock. WDA is released only after its active
   consumers are gone and the runner grace period expires.

## Port mapping

| Device slot | WDA on Mac mini | MJPEG through tunnel |
| --- | ---: | ---: |
| 1 | 8100 | 9200 |
| 2 | 8101 | 9201 |
| 3 | 8102 | 9202 |
| 4 | 8103 | 9203 |
| 5 | 8104 | 9204 |

Appium listens once on `4723`. The SSH tunnel forwards `4723` and `9200-9204`. The WDA ports
`8100-8104` are local to the Mac mini and must not be forwarded to Ubuntu.

## Signing and metadata

The Mac mini owns the Apple signing material:

- `.p12` in the login Keychain;
- `.mobileprovision` installed for Xcode;
- explicit WDA Bundle ID and Team ID.

ws-scrcpy sends signing identifiers as Appium capabilities, but never transports private signing
material. After WDA is ready, the server requests `mobile: deviceInfo` and updates the iOS descriptor
with name, model, and iOS version when the driver provides those fields.

## Android boundary

Android discovery and ADB are separate from this iOS architecture. The iOS work must not change:

- ADB server configuration;
- Android `ControlCenter` instances;
- the shared device-lock semantics;
- Android frontend tools.

This boundary is intentional because the lab can use local and remote ADB servers independently of
the Mac mini Appium host.

## Failure and recovery

The Appium client treats a session as stale when its WDA endpoint no longer responds. It then removes
only that UDID's session and retries. Other iOS devices remain independent through their WDA ports.

If metadata lookup fails, the session remains usable; metadata is best effort and does not block WDA
or MJPEG startup. If WDA signing fails, Appium session creation fails and the device remains available
for a later retry rather than affecting Android devices.
