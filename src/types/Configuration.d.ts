import * as https from 'https';

export type OperatingSystem = 'android' | 'ios';

export interface HostItem {
    type: OperatingSystem;
    secure: boolean;
    hostname: string;
    port: number;
    pathname?: string;
    useProxy?: boolean;
}

export interface HostsItem {
    type: OperatingSystem | OperatingSystem[];
    secure: boolean;
    hostname: string;
    port: number;
    pathname?: string;
    useProxy?: boolean;
}

export type ExtendedServerOption = https.ServerOptions & {
    certPath?: string;
    keyPath?: string;
};

export interface ServerItem {
    secure: boolean;
    port: number;
    options?: ExtendedServerOption;
    redirectToSecure?:
        | {
              port?: number;
              host?: string;
          }
        | boolean;
}

export interface AdbServerItem {
    host: string;
    port?: number;
    name?: string;
}

// Statically configured iOS device with a WebDriverAgent already running and reachable,
// used when ws-scrcpy has no local USB/usbmuxd access to the device (e.g. device is
// physically attached to another host and WDA's port is tunneled/forwarded to this machine).
export interface ApplRemoteDeviceItem {
    udid: string;
    name?: string;
    // Base URL of a running Appium server (XCUITest driver) or a bare WebDriverAgent instance
    // that already has local Xcode/usbmuxd access to this device, e.g. "http://192.168.1.10:4723"
    // (Appium) or "http://127.0.0.1:8100" (WDA directly, via an SSH tunnel/port-forward).
    webDriverAgentUrl: string;
    // Local port already tunneled to the device's WDA MJPEG broadcaster (e.g. via a second
    // iproxy + SSH port-forward). Required for MJPEG streaming in remote mode.
    mjpegLocalPort?: number;
}

// The configuration file must contain a single object with this structure
export interface Configuration {
    server?: ServerItem[];
    runApplTracker?: boolean;
    announceApplTracker?: boolean;
    runGoogTracker?: boolean;
    announceGoogTracker?: boolean;
    remoteHostList?: HostsItem[];
    adbHost?: string;
    adbPort?: number;
    adbListenAllInterfaces?: boolean;
    adbServers?: AdbServerItem[];
    applDeviceList?: ApplRemoteDeviceItem[];
}
