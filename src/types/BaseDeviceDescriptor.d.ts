export interface CambrionixInfo {
    /** Human-readable label of the hub that provided this data (from config `name`). */
    source: string;
    /** Physical port number on the hub (1-based). */
    port: number;
    /** Power state as reported by the hub (e.g. "on", "off", "auto"). */
    powerState: string;
    /** Connection state as reported by the hub (e.g. "connected", "disconnected"). */
    connectionState: string;
}

export interface BaseDeviceDescriptor {
    udid: string;
    state: string;
    /** Enrichment data from a Cambrionix hub, if available. */
    cambrionix?: CambrionixInfo;
}
