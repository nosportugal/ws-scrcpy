import { NetInterface } from './NetInterface';
import { BaseDeviceDescriptor } from './BaseDeviceDescriptor';

export default interface GoogDeviceDescriptor extends BaseDeviceDescriptor {
    'ro.build.version.release': string;
    'ro.build.version.sdk': string;
    'ro.product.cpu.abi': string;
    'ro.product.manufacturer': string;
    'ro.product.model': string;
    'ro.product.marketname': string;
    'ro.config.marketing_name': string;
    'ro.vendor.oplus.market.name': string;
    'ro.hardware.wifi': string;
    'wifi.interface': string;
    interfaces: NetInterface[];
    pid: number;
    scrcpyConnectionCount: number;
    wsBusy: boolean;
    adbBusy: boolean;
    busyReason: 'none' | 'ws' | 'adb' | 'ws+adb';
    'last.update.timestamp': number;
}
