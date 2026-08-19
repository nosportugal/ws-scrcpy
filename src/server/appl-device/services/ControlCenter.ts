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
        const descriptor = {
            udid,
            name,
            model,
            version,
            state,
            'last.update.timestamp': Date.now(),
            details: this.createNativeDetails(name, model, state),
        };
        this.descriptors.set(udid, descriptor);
        this.emit('device', descriptor);
        this.refreshEnrichedDetails(descriptor);
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
            enrichmentState: this.cambrionixEnricher.isEnabled() ? 'loading' : 'idle',
            enrichmentMessage: this.cambrionixEnricher.isEnabled()
                ? 'Awaiting Cambrionix enrichment'
                : 'Cambrionix disabled',
            updatedAt: Date.now(),
        };
    }

    private refreshEnrichedDetails(descriptor: ApplDeviceDescriptor): void {
        if (!this.cambrionixEnricher.isEnabled()) {
            return;
        }
        const udid = descriptor.udid;
        const now = Date.now();
        const last = this.lastEnrichByUdid.get(udid) || 0;
        if (this.enrichInFlightByUdid.get(udid) || now - last < this.cambrionixEnricher.getPollIntervalMs()) {
            return;
        }
        this.lastEnrichByUdid.set(udid, now);
        this.enrichInFlightByUdid.set(udid, true);
        this.cambrionixEnricher
            .enrichByIdentifier(udid)
            .then((cambrionixDetails) => {
                const current = this.descriptors.get(udid);
                if (!current) {
                    return;
                }
                const native = this.createNativeDetails(current.name, current.model, current.state);
                if (!cambrionixDetails) {
                    current.details = {
                        ...native,
                        enrichmentState: 'unavailable',
                        enrichmentMessage: 'Cambrionix details not found',
                    };
                } else {
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
