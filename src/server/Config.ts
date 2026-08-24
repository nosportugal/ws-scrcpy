import * as process from 'process';
import * as fs from 'fs';
import * as path from 'path';
import { AdbServerItem, ApplRemoteDeviceItem, Configuration, HostItem, ServerItem } from '../types/Configuration';
import { EnvName } from './EnvName';
import YAML from 'yaml';

const DEFAULT_PORT = 8000;

const YAML_RE = /^.+\.(yaml|yml)$/i;
const JSON_RE = /^.+\.(json|js)$/i;

type FullConfiguration = Omit<Required<Configuration>, 'adbHost' | 'adbPort'> &
    Pick<Configuration, 'adbHost' | 'adbPort'>;

export class Config {
    private static instance?: Config;
    private static initConfig(userConfig: Configuration = {}): FullConfiguration {
        let runGoogTracker = false;
        let announceGoogTracker = false;
        /// #if INCLUDE_GOOG
        runGoogTracker = true;
        announceGoogTracker = true;
        /// #endif

        let runApplTracker = false;
        let announceApplTracker = false;
        /// #if INCLUDE_APPL
        runApplTracker = true;
        announceApplTracker = true;
        /// #endif
        const server: ServerItem[] = [
            {
                secure: false,
                port: DEFAULT_PORT,
            },
        ];
        const defaultConfig: FullConfiguration = {
            runGoogTracker,
            runApplTracker,
            announceGoogTracker,
            announceApplTracker,
            server,
            remoteHostList: [],
            adbHost: undefined,
            adbPort: undefined,
            adbListenAllInterfaces: true,
            adbServers: [
                { host: '127.0.0.1', port: 5037 },
                { host: '192.168.200.37', port: 5037, name: '3P-Appium-iOS.local' },
            ],
            applDeviceList: [
                {
                    udid: '00008101-001220200CB8001E',
                    name: 'iPhone (lab)',
                    webDriverAgentUrl: 'http://192.168.200.37:4723',
                    mjpegLocalPort: 9200,
                },
            ],
        };
        const merged = Object.assign({}, defaultConfig, userConfig);
        merged.server = merged.server.map((item) => this.parseServerItem(item));
        return merged;
    }
    private static parseServerItem(config: Partial<ServerItem> = {}): ServerItem {
        const secure = config.secure || false;
        const port = config.port || (secure ? 443 : 80);
        const options = config.options;
        const redirectToSecure = config.redirectToSecure || false;
        if (secure && !options) {
            throw Error('Must provide "options" for secure server configuration');
        }
        if (options?.certPath) {
            if (options.cert) {
                throw Error(`Can't use "cert" and "certPath" together`);
            }
            options.cert = this.readFile(options.certPath);
        }
        if (options?.keyPath) {
            if (options.key) {
                throw Error(`Can't use "key" and "keyPath" together`);
            }
            options.key = this.readFile(options.keyPath);
        }
        const serverItem: ServerItem = {
            secure,
            port,
            redirectToSecure,
        };
        if (typeof options !== 'undefined') {
            serverItem.options = options;
        }
        if (typeof redirectToSecure === 'boolean') {
            serverItem.redirectToSecure = redirectToSecure;
        }
        return serverItem;
    }
    public static getInstance(): Config {
        if (!this.instance) {
            const configPath = process.env[EnvName.CONFIG_PATH];
            let userConfig: Configuration;
            if (!configPath) {
                userConfig = {};
            } else {
                if (configPath.match(YAML_RE)) {
                    userConfig = YAML.parse(this.readFile(configPath));
                } else if (configPath.match(JSON_RE)) {
                    userConfig = JSON.parse(this.readFile(configPath));
                } else {
                    throw Error(`Unknown file type: ${configPath}`);
                }
            }
            const fullConfig = this.initConfig(userConfig);
            this.instance = new Config(fullConfig);
        }
        return this.instance;
    }

    public static readFile(pathString: string): string {
        const isAbsolute = pathString.startsWith('/');
        const absolutePath = isAbsolute ? pathString : path.resolve(process.cwd(), pathString);
        if (!fs.existsSync(absolutePath)) {
            throw Error(`Can't find file "${absolutePath}"`);
        }
        return fs.readFileSync(absolutePath).toString();
    }

    constructor(private fullConfig: FullConfiguration) {}

    public getHostList(): HostItem[] {
        if (!this.fullConfig.remoteHostList || !this.fullConfig.remoteHostList.length) {
            return [];
        }
        const hostList: HostItem[] = [];
        this.fullConfig.remoteHostList.forEach((item) => {
            const { hostname, port, pathname, secure, useProxy } = item;
            if (Array.isArray(item.type)) {
                item.type.forEach((type) => {
                    hostList.push({
                        hostname,
                        port,
                        pathname,
                        secure,
                        useProxy,
                        type,
                    });
                });
            } else {
                hostList.push({ hostname, port, pathname, secure, useProxy, type: item.type });
            }
        });
        return hostList;
    }

    public get runLocalGoogTracker(): boolean {
        return this.fullConfig.runGoogTracker;
    }

    public get announceLocalGoogTracker(): boolean {
        return this.fullConfig.runGoogTracker;
    }

    public get runLocalApplTracker(): boolean {
        return this.fullConfig.runApplTracker;
    }

    public get announceLocalApplTracker(): boolean {
        return this.fullConfig.runApplTracker;
    }

    public get servers(): ServerItem[] {
        return this.fullConfig.server;
    }

    public get adbHost(): string | undefined {
        return this.fullConfig.adbHost;
    }

    public get adbPort(): number | undefined {
        return this.fullConfig.adbPort;
    }

    public get adbListenAllInterfaces(): boolean {
        return this.fullConfig.adbListenAllInterfaces;
    }

    public get adbServers(): AdbServerItem[] {
        // If adbServers is explicitly configured, use it.
        // Otherwise fall back to legacy adbHost/adbPort if set.
        if (this.fullConfig.adbServers && this.fullConfig.adbServers.length) {
            return this.fullConfig.adbServers;
        }
        if (this.fullConfig.adbHost) {
            return [{ host: this.fullConfig.adbHost, port: this.fullConfig.adbPort || 5037 }];
        }
        return [{ host: '127.0.0.1', port: 5037 }];
    }

    public getApplDeviceList(): ApplRemoteDeviceItem[] {
        return this.fullConfig.applDeviceList || [];
    }
}
