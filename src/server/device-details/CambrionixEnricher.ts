import * as http from 'http';
import * as https from 'https';
import { Config } from '../Config';
import { DeviceDetails } from '../../types/DeviceDetails';

type CambrionixDevicePayload = Partial<DeviceDetails>;

type NormalizedCambrionixDevice = {
    identifiers: string[];
    details: CambrionixDevicePayload;
};

export class CambrionixEnricher {
    private static instance?: CambrionixEnricher;
    private cacheExpiresAt = 0;
    private normalizedDevices: NormalizedCambrionixDevice[] = [];
    private loadingPromise?: Promise<NormalizedCambrionixDevice[]>;

    public static getInstance(): CambrionixEnricher {
        if (!this.instance) {
            this.instance = new CambrionixEnricher();
        }
        return this.instance;
    }

    public isEnabled(): boolean {
        const cfg = Config.getInstance().cambrionix;
        return cfg.enabled && !!cfg.baseUrl;
    }

    public getPollIntervalMs(): number {
        return Config.getInstance().cambrionix.pollIntervalMs;
    }

    public async enrichByIdentifier(...identifiers: string[]): Promise<CambrionixDevicePayload | undefined> {
        if (!this.isEnabled()) {
            return;
        }
        const idList = identifiers.map(this.normalize).filter((value) => !!value);
        if (!idList.length) {
            return;
        }
        const devices = await this.getNormalizedDevices();
        const match = devices.find((item) => item.identifiers.some((identifier) => idList.includes(identifier)));
        return match?.details;
    }

    private async getNormalizedDevices(): Promise<NormalizedCambrionixDevice[]> {
        const now = Date.now();
        const cfg = Config.getInstance().cambrionix;
        if (now < this.cacheExpiresAt && this.normalizedDevices.length > 0) {
            return this.normalizedDevices;
        }
        if (this.loadingPromise) {
            return this.loadingPromise;
        }
        this.loadingPromise = this.loadDevices(cfg.retryCount)
            .then((devices) => {
                this.normalizedDevices = devices;
                this.cacheExpiresAt = Date.now() + cfg.cacheTtlMs;
                return devices;
            })
            .finally(() => {
                this.loadingPromise = undefined;
            });
        return this.loadingPromise;
    }

    private async loadDevices(retryCount: number): Promise<NormalizedCambrionixDevice[]> {
        let lastError: Error | undefined;
        for (let attempt = 0; attempt <= retryCount; attempt++) {
            try {
                const response = await this.fetchDevicesPayload();
                return this.normalizeDevicesPayload(response);
            } catch (error) {
                lastError = error as Error;
                if (attempt < retryCount) {
                    console.warn(`[Cambrionix] Enrichment fetch retry ${attempt + 1}/${retryCount}`);
                }
            }
        }
        if (lastError) {
            throw lastError;
        }
        return [];
    }

    private async fetchDevicesPayload(): Promise<unknown> {
        const cfg = Config.getInstance().cambrionix;
        const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
        const path = cfg.deviceListPath.startsWith('/') ? cfg.deviceListPath : `/${cfg.deviceListPath}`;
        const url = new URL(`${baseUrl}${path}`);
        const client = url.protocol === 'https:' ? https : http;
        return new Promise<unknown>((resolve, reject) => {
            const request = client.get(url, (response) => {
                if (response.statusCode && response.statusCode >= 400) {
                    reject(new Error(`[Cambrionix] Request failed with status ${response.statusCode}`));
                    response.resume();
                    return;
                }
                let body = '';
                response.on('data', (chunk) => {
                    body += chunk.toString();
                });
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            request.setTimeout(cfg.timeoutMs, () => {
                request.destroy(new Error(`[Cambrionix] Request timed out after ${cfg.timeoutMs}ms`));
            });
            request.on('error', reject);
        });
    }

    private normalizeDevicesPayload(payload: unknown): NormalizedCambrionixDevice[] {
        const candidates = this.extractDeviceCandidates(payload);
        const devices: NormalizedCambrionixDevice[] = [];
        candidates.forEach((candidate) => {
            const identifiers = this.extractIdentifiers(candidate).map(this.normalize).filter((value) => !!value);
            if (!identifiers.length) {
                return;
            }
            devices.push({
                identifiers: Array.from(new Set(identifiers)),
                details: this.extractDetails(candidate),
            });
        });
        return devices;
    }

    private extractDeviceCandidates(payload: unknown): Record<string, unknown>[] {
        if (Array.isArray(payload)) {
            return payload.filter(this.isObject);
        }
        if (!this.isObject(payload)) {
            return [];
        }
        const direct = this.objectLooksLikeDevice(payload) ? [payload] : [];
        const nestedKeys = ['devices', 'data', 'result', 'ports', 'entries', 'items'];
        const nested: Record<string, unknown>[] = [];
        nestedKeys.forEach((key) => {
            const value = payload[key];
            if (Array.isArray(value)) {
                value.filter(this.isObject).forEach((item) => nested.push(item));
            } else if (this.isObject(value)) {
                this.extractDeviceCandidates(value).forEach((item) => nested.push(item));
            }
        });
        return [...direct, ...nested];
    }

    private objectLooksLikeDevice(value: Record<string, unknown>): boolean {
        return this.extractIdentifiers(value).length > 0;
    }

    private extractIdentifiers(payload: Record<string, unknown>): string[] {
        const keys = ['udid', 'serial', 'serialNumber', 'serial_number', 'deviceId', 'device_id', 'id'];
        const result: string[] = [];
        keys.forEach((key) => {
            const value = payload[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                result.push(value);
            }
        });
        return result;
    }

    private extractDetails(payload: Record<string, unknown>): CambrionixDevicePayload {
        const marketName = this.firstString(payload, [
            'marketName',
            'marketingName',
            'productName',
            'commercialName',
            'friendlyName',
        ]);
        const modelCode = this.firstString(payload, ['modelCode', 'model', 'modelName', 'productType']);
        const usbHub = this.firstString(payload, ['hubName', 'hub', 'hubSerial', 'hubId']);
        const usbPort = this.firstString(payload, ['portName', 'port', 'portNumber', 'connector']);
        const powerStatus = this.firstString(payload, ['powerStatus', 'power', 'wattage', 'current']);
        const healthStatus = this.firstString(payload, ['healthStatus', 'health', 'batteryHealth']);
        const connectionStatus = this.firstString(payload, ['connectionStatus', 'status', 'state']);
        return {
            marketName,
            modelCode,
            usbHub,
            usbPort,
            powerStatus,
            healthStatus,
            connectionStatus,
            source: 'cambrionix',
            updatedAt: Date.now(),
        };
    }

    private firstString(payload: Record<string, unknown>, keys: string[]): string {
        for (const key of keys) {
            const value = payload[key];
            if (typeof value === 'string' && value.trim().length) {
                return value.trim();
            }
            if (typeof value === 'number' || typeof value === 'boolean') {
                return String(value);
            }
        }
        return '';
    }

    private isObject = (value: unknown): value is Record<string, unknown> => {
        return typeof value === 'object' && value !== null;
    };

    private normalize(value: string): string {
        return value.trim().toLowerCase();
    }
}
