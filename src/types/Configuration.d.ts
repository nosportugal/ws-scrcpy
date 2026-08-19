import * as https from 'https';

export interface CambrionixSourceConfig {
    /** Human-readable label for logs (e.g. "hub-a"). Defaults to index. */
    name?: string;
    /** Whether this source is active (default: true). */
    enable?: boolean;
    /** Base URL of the Cambrionix Hub Manager API, e.g. http://10.0.0.10:9595 */
    baseUrl: string;
    /** API path to the port list (default: /api/v1/port). */
    path?: string;
    /** Request timeout in milliseconds (default: 5000). */
    timeoutMs?: number;
    /** Delay before retrying after a failed request, in ms (default: 10000). */
    retryDelayMs?: number;
    /** How long to consider a successful response valid, in ms (default: 30000). */
    cacheMs?: number;
    /** How often to proactively refresh the cache in ms (default: 20000). */
    pollMs?: number;
}

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
    /** List of Cambrionix Hub Manager sources for device enrichment. */
    cambrionixSources?: CambrionixSourceConfig[];
}
