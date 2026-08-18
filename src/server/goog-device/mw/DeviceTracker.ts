import WS from 'ws';
import { Mw, RequestParameters } from '../../mw/Mw';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { ControlCenter } from '../services/ControlCenter';
import { ACTION } from '../../../common/Action';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { DeviceTrackerEvent } from '../../../types/DeviceTrackerEvent';
import { DeviceTrackerEventList } from '../../../types/DeviceTrackerEventList';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ChannelCode } from '../../../common/ChannelCode';

export class DeviceTracker extends Mw {
    public static readonly TAG = 'DeviceTracker';
    public static readonly type = 'android';
    private readonly controlCenters: ControlCenter[] = ControlCenter.getInstances();

    public static processChannel(ws: Multiplexer, code: string): Mw | undefined {
        if (code !== ChannelCode.GTRC) {
            return;
        }
        return new DeviceTracker(ws);
    }

    public static processRequest(ws: WS, params: RequestParameters): DeviceTracker | undefined {
        if (params.action !== ACTION.GOOG_DEVICE_LIST) {
            return;
        }
        return new DeviceTracker(ws);
    }

    constructor(ws: WS | Multiplexer) {
        super(ws);

        const initPromises = this.controlCenters.map((cc) =>
            cc
                .init()
                .then(() => {
                    cc.on('device', this.sendDeviceMessage);
                })
                .catch((error: Error) => {
                    console.error(`[${DeviceTracker.TAG}] Error: ${error.message}`);
                }),
        );
        Promise.all(initPromises).then(() => {
            this.buildAndSendMessage(ControlCenter.getAllDevices());
        });
    }

    private sendDeviceMessage = (device: GoogDeviceDescriptor): void => {
        // Find which ControlCenter owns this device
        for (const cc of this.controlCenters) {
            if (cc.getDevice(device.udid)) {
                const data: DeviceTrackerEvent<GoogDeviceDescriptor> = {
                    device,
                    id: cc.getId(),
                    name: cc.getName(),
                };
                this.sendMessage({
                    id: -1,
                    type: 'device',
                    data,
                });
                return;
            }
        }
    };

    private buildAndSendMessage = (list: GoogDeviceDescriptor[]): void => {
        const cc = this.controlCenters[0];
        const data: DeviceTrackerEventList<GoogDeviceDescriptor> = {
            list,
            id: cc?.getId() || '',
            name: cc?.getName() || 'Unknown',
        };
        this.sendMessage({
            id: -1,
            type: 'devicelist',
            data,
        });
    };

    protected onSocketMessage(event: WS.MessageEvent): void {
        let command: ControlCenterCommand;
        try {
            command = ControlCenterCommand.fromJSON(event.data.toString());
        } catch (error: any) {
            console.error(`[${DeviceTracker.TAG}], Received message: ${event.data}. Error: ${error?.message}`);
            return;
        }
        // Find the ControlCenter that has the device
        const udid = command.getUdid();
        for (const cc of this.controlCenters) {
            if (cc.getDevice(udid)) {
                cc.runCommand(command).catch((e) => {
                    console.error(`[${DeviceTracker.TAG}], Received message: ${event.data}. Error: ${e.message}`);
                });
                return;
            }
        }
        console.error(`[${DeviceTracker.TAG}] Device "${udid}" not found in any ControlCenter`);
    }

    public release(): void {
        super.release();
        for (const cc of this.controlCenters) {
            cc.off('device', this.sendDeviceMessage);
        }
    }
}
