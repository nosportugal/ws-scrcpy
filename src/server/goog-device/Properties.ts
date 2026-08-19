import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';

export const Properties: ReadonlyArray<keyof GoogDeviceDescriptor> = [
    'ro.product.cpu.abi',
    'ro.product.manufacturer',
    'ro.product.model',
    'ro.product.marketname',
    'ro.config.marketing_name',
    'ro.vendor.oplus.market.name',
    'ro.hardware.wifi',
    'ro.build.version.release',
    'ro.build.version.sdk',
    'wifi.interface',
];
