import { DeviceDetails } from './DeviceDetails';

export interface BaseDeviceDescriptor {
    udid: string;
    state: string;
    details?: DeviceDetails;
}
