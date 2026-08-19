export type DeviceDetailsSource = 'native' | 'cambrionix' | 'merged';

export type DeviceEnrichmentState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

export interface DeviceDetails {
    marketName: string;
    modelCode: string;
    usbHub: string;
    usbPort: string;
    powerStatus: string;
    healthStatus: string;
    connectionStatus: string;
    source: DeviceDetailsSource;
    enrichmentState: DeviceEnrichmentState;
    enrichmentMessage: string;
    updatedAt: number;
}
