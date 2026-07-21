import { NetInterface } from './NetInterface';
import { BaseDeviceDescriptor } from './BaseDeviceDescriptor';

export default interface GoogDeviceDescriptor extends BaseDeviceDescriptor {
    'ro.build.version.release': string;
    'ro.build.version.sdk': string;
    'ro.product.cpu.abi': string;
    'ro.product.manufacturer': string;
    'ro.product.model': string;
    'wifi.interface': string;
    interfaces: NetInterface[];
    pid: number;
    wsBusy: boolean;
    adbBusy: boolean;
    busyReason: 'none' | 'ws' | 'adb' | 'ws+adb';
    'last.update.timestamp': number;
}
