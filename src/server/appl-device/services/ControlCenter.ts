import { Service } from '../../services/Service';
import { BaseControlCenter } from '../../services/BaseControlCenter';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import * as os from 'os';
import * as crypto from 'crypto';
import ApplDeviceDescriptor from '../../../types/ApplDeviceDescriptor';
import { IOSDeviceLib } from 'ios-device-lib';
import { DeviceState } from '../../../common/DeviceState';
import { ProductType } from '../../../common/ProductType';
import { CambrionixEnricher } from '../../device-details/CambrionixEnricher';
import { DeviceDetails } from '../../../types/DeviceDetails';

export class ControlCenter extends BaseControlCenter<ApplDeviceDescriptor> implements Service {
    private static instance?: ControlCenter;
    private readonly TAG = '[ControlCenter][Cambrionix]';

    private initialized = false;
    private tracker?: IOSDeviceLib.IOSDeviceLib;
    private descriptors: Map<string, ApplDeviceDescriptor> = new Map();
    private readonly cambrionixEnricher = CambrionixEnricher.getInstance();
    private readonly enrichInFlightByUdid: Map<string, boolean> = new Map();
    private readonly lastEnrichByUdid: Map<string, number> = new Map();
    private readonly id: string;

    protected constructor() {
        super();
        const idString = `appl|${os.hostname()}|${os.uptime()}`;
        this.id = crypto.createHash('md5').update(idString).digest('hex');
    }

    public static getInstance(): ControlCenter {
        if (!this.instance) {
            this.instance = new ControlCenter();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!ControlCenter.instance;
    }

    private onDeviceUpdate = (device: IOSDeviceLib.IDeviceActionInfo): void => {
        const udid = device.deviceId;
        const state = device.status || '<NoState>';
        const name = device.deviceName || '<NoName>';
        const productType = device.productType || '<NoModel>';
        const version = device.productVersion || '<NoVersion>';
        const model = ProductType.getModel(productType);
        const previous = this.descriptors.get(udid);
        const details = this.mergeDetailsWithNative(previous?.details, name, model, state);
        const descriptor = {
            udid,
            name,
            model,
            version,
            state,
            'last.update.timestamp': Date.now(),
            details,
        };
        this.descriptors.set(udid, descriptor);
        this.emit('device', descriptor);
        this.refreshEnrichedDetails(
            descriptor,
            this.collectEnrichmentIdentifiers(
                udid,
                (device as unknown as Record<string, unknown>).serialNumber,
                (device as unknown as Record<string, unknown>).serial,
                (device as unknown as Record<string, unknown>).udid,
            ),
        );
    };

    private onDeviceLost = (device: IOSDeviceLib.IDeviceActionInfo): void => {
        const udid = device.deviceId;
        const descriptor = this.descriptors.get(udid);
        if (!descriptor) {
            console.warn(`Received "lost" event for unknown device "${udid}"`);
            return;
        }
        descriptor.state = DeviceState.DISCONNECTED;
        descriptor.details = {
            ...this.createNativeDetails(descriptor.name, descriptor.model, descriptor.state),
            enrichmentState: 'idle',
            enrichmentMessage: 'Device offline',
        };
        this.enrichInFlightByUdid.delete(udid);
        this.lastEnrichByUdid.delete(udid);
        this.emit('device', descriptor);
    };

    public async init(): Promise<void> {
        if (this.initialized) {
            return;
        }
        this.tracker = await this.startTracker();
        this.initialized = true;
    }

    private async startTracker(): Promise<IOSDeviceLib.IOSDeviceLib> {
        if (this.tracker) {
            return this.tracker;
        }
        this.tracker = new IOSDeviceLib(this.onDeviceUpdate, this.onDeviceUpdate, this.onDeviceLost);
        return this.tracker;
    }

    private stopTracker(): void {
        if (this.tracker) {
            this.tracker.dispose();
            this.tracker = undefined;
        }
        this.tracker = undefined;
        this.initialized = false;
    }

    public getDevices(): ApplDeviceDescriptor[] {
        return Array.from(this.descriptors.values());
    }

    public getId(): string {
        return this.id;
    }

    public getName(): string {
        return `iDevice Tracker [${os.hostname()}]`;
    }

    public start(): Promise<void> {
        return this.init().catch((e) => {
            console.error(`Error: Failed to init "${this.getName()}". ${e.message}`);
        });
    }

    public release(): void {
        this.stopTracker();
    }

    public async runCommand(command: ControlCenterCommand): Promise<string | void> {
        const udid = command.getUdid();
        const device = this.descriptors.get(udid);
        if (!device) {
            console.error(`Device with udid:"${udid}" not found`);
            return;
        }
        const type = command.getType();
        switch (type) {
            default:
                throw new Error(`Unsupported command: "${type}"`);
        }
    }

    private createNativeDetails(name: string, model: string, state: string): DeviceDetails {
        return {
            marketName: name || 'Unknown',
            modelCode: model || 'Unknown',
            usbHub: 'Unknown',
            usbPort: 'Unknown',
            powerStatus: 'Unknown',
            healthStatus: 'Unknown',
            connectionStatus: state || 'Unknown',
            source: 'native',
            enrichmentState: 'idle',
            enrichmentMessage: this.cambrionixEnricher.isEnabled()
                ? 'Awaiting Cambrionix enrichment'
                : 'Cambrionix disabled',
            updatedAt: Date.now(),
        };
    }

    private mergeDetailsWithNative(
        previous: DeviceDetails | undefined,
        name: string,
        model: string,
        state: string,
    ): DeviceDetails {
        const native = this.createNativeDetails(name, model, state);
        if (!previous) {
            return native;
        }
        return {
            ...native,
            ...previous,
            connectionStatus: state || previous.connectionStatus || native.connectionStatus,
            updatedAt: Date.now(),
        };
    }

    private collectEnrichmentIdentifiers(...values: unknown[]): string[] {
        const identifiers = values
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
        return Array.from(new Set(identifiers));
    }

    private refreshEnrichedDetails(descriptor: ApplDeviceDescriptor, identifiers: string[]): void {
        if (!this.cambrionixEnricher.isEnabled()) {
            return;
        }
        const udid = descriptor.udid;
        const now = Date.now();
        const last = this.lastEnrichByUdid.get(udid) || 0;
        if (this.enrichInFlightByUdid.get(udid)) {
            console.info(`${this.TAG} skip enrich ${udid}: request already in flight`);
            return;
        }
        if (now - last < this.cambrionixEnricher.getPollIntervalMs()) {
            console.info(`${this.TAG} skip enrich ${udid}: poll interval not reached`);
            return;
        }
        console.info(`${this.TAG} start enrich ${udid}`);
        this.lastEnrichByUdid.set(udid, now);
        this.enrichInFlightByUdid.set(udid, true);
        const current = this.descriptors.get(udid);
        if (current?.details && current.details.enrichmentState !== 'ready') {
            current.details = {
                ...current.details,
                enrichmentState: 'loading',
                enrichmentMessage: 'Fetching Cambrionix details',
                updatedAt: Date.now(),
            };
            this.emit('device', current);
        }
        this.cambrionixEnricher
            .enrichByIdentifier(...identifiers)
            .then((cambrionixDetails) => {
                const current = this.descriptors.get(udid);
                if (!current) {
                    return;
                }
                const native = this.createNativeDetails(current.name, current.model, current.state);
                if (!cambrionixDetails) {
                    console.info(`${this.TAG} enrich finished ${udid}: no Cambrionix match`);
                    current.details = {
                        ...native,
                        enrichmentState: 'unavailable',
                        enrichmentMessage: 'Cambrionix details not found',
                    };
                } else {
                    console.info(`${this.TAG} enrich finished ${udid}: details merged`);
                    current.details = {
                        ...native,
                        ...cambrionixDetails,
                        source: 'merged',
                        enrichmentState: 'ready',
                        enrichmentMessage: 'Enriched by Cambrionix',
                        updatedAt: Date.now(),
                    };
                }
                this.emit('device', current);
            })
            .catch((error: Error) => {
                console.warn(`${this.TAG} enrich failed ${udid}: ${error.message}`);
                const current = this.descriptors.get(udid);
                if (!current) {
                    return;
                }
                current.details = {
                    ...this.createNativeDetails(current.name, current.model, current.state),
                    enrichmentState: 'error',
                    enrichmentMessage: error.message,
                    updatedAt: Date.now(),
                };
                this.emit('device', current);
            })
            .finally(() => {
                this.enrichInFlightByUdid.delete(udid);
            });
    }
}
