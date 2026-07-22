import Adb from '@dead50f7/adbkit/lib/adb';
import { ExtendedClient } from './ExtendedClient';
import { ClientOptions } from '@dead50f7/adbkit/lib/ClientOptions';

interface Options {
    host?: string;
    port?: number;
    bin?: string;
}

export class AdbExtended extends Adb {
    private static defaultOptions: Options = {};

    static setDefaultOptions(options: Options): void {
        AdbExtended.defaultOptions = options;
    }

    static createClient(options: Options = {}): ExtendedClient {
        const mergedOptions = { ...AdbExtended.defaultOptions, ...options };
        const opts: ClientOptions = {
            bin: mergedOptions.bin,
            host: mergedOptions.host || process.env.ADB_HOST || '0.0.0.0',
            port: mergedOptions.port || 0,
        };
        if (!opts.port) {
            const port = parseInt(process.env.ADB_PORT || '', 10);
            if (!isNaN(port)) {
                opts.port = port;
            } else {
                opts.port = 5037;
            }
        }
        return new ExtendedClient(opts);
    }
}
