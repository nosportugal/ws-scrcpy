import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { TypedEmitter } from '../../../common/TypedEmitter';
import * as portfinder from 'portfinder';
import { Server, XCUITestDriver } from '../../../types/WdaServer';
import * as XCUITest from 'appium-xcuitest-driver';
import { WDAMethod } from '../../../common/WDAMethod';
import { timing } from 'appium-support';
import { WdaStatus } from '../../../common/WdaStatus';
import { ControlCenter } from './ControlCenter';
import { WdaHttpClient } from './WdaHttpClient';

const MJPEG_SERVER_PORT = 9100;

export interface WdaRunnerEvents {
    'status-change': { status: WdaStatus; text?: string; code?: number };
    error: Error;
}

export class WdaRunner extends TypedEmitter<WdaRunnerEvents> {
    protected static TAG = 'WDARunner';
    private static instances: Map<string, WdaRunner> = new Map();
    public static SHUTDOWN_TIMEOUT = 15000;
    private static servers: Map<string, Server> = new Map();
    private static cachedScreenWidth: Map<string, any> = new Map();
    public static getInstance(udid: string): WdaRunner {
        let instance = this.instances.get(udid);
        if (!instance) {
            instance = new WdaRunner(udid);
            this.instances.set(udid, instance);
        }
        instance.lock();
        return instance;
    }
    public static async getServer(udid: string): Promise<Server> {
        let server = this.servers.get(udid);
        if (!server) {
            const port = await portfinder.getPortPromise();
            server = await XCUITest.startServer(port, '127.0.0.1');
            server.on('error', (...args: any[]) => {
                console.error('Server Error:', args);
            });
            server.on('close', (...args: any[]) => {
                console.error('Server Close:', args);
            });
            this.servers.set(udid, server);
        }
        return server;
    }

    public static async getScreenWidth(udid: string, driver: XCUITestDriver): Promise<number> {
        const cached = this.cachedScreenWidth.get(udid);
        if (cached) {
            return cached;
        }
        const info = await driver.getScreenInfo();
        if (info && info.statusBarSize.width > 0) {
            const screenWidth = info.statusBarSize.width;
            this.cachedScreenWidth.set(udid, screenWidth);
            return screenWidth;
        }
        const el = await driver.findElement('xpath', '//XCUIElementTypeApplication');
        const size = await driver.getSize(el);
        if (size) {
            const screenWidth = size.width;
            this.cachedScreenWidth.set(udid, screenWidth);
            return screenWidth;
        }
        return 0;
    }

    protected name: string;
    protected started = false;
    protected starting = false;
    private server?: Server;
    private remoteClient?: WdaHttpClient;
    private mjpegServerPort = 0;
    private wdaLocalPort = 0;
    private holders = 0;
    protected releaseTimeoutId?: NodeJS.Timeout;

    constructor(private readonly udid: string) {
        super();
        this.name = `[${WdaRunner.TAG}][udid: ${this.udid}]`;
    }

    protected lock(): void {
        if (this.releaseTimeoutId) {
            clearTimeout(this.releaseTimeoutId);
        }
        this.holders++;
    }

    protected unlock(): void {
        this.holders--;
        if (this.holders > 0) {
            return;
        }
        this.releaseTimeoutId = setTimeout(async () => {
            WdaRunner.servers.delete(this.udid);
            WdaRunner.instances.delete(this.udid);
            if (this.remoteClient) {
                await this.remoteClient.deleteSession();
                delete this.remoteClient;
            }
            if (this.server) {
                if (this.server.driver) {
                    await this.server.driver.deleteSession();
                }
                this.server.close();
                delete this.server;
            }
        }, WdaRunner.SHUTDOWN_TIMEOUT);
    }

    public get mjpegPort(): number {
        return this.mjpegServerPort;
    }

    public async request(command: ControlCenterCommand): Promise<any> {
        if (this.remoteClient) {
            return this.requestRemote(this.remoteClient, command);
        }
        const driver = this.server?.driver;
        if (!driver) {
            return;
        }

        const method = command.getMethod();
        const args = command.getArgs();
        switch (method) {
            case WDAMethod.GET_SCREEN_WIDTH:
                return WdaRunner.getScreenWidth(this.udid, driver);
            case WDAMethod.CLICK:
                return driver.performTouch([{ action: 'tap', options: { x: args.x, y: args.y } }]);
            case WDAMethod.PRESS_BUTTON:
                return driver.mobilePressButton({ name: args.name });
            case WDAMethod.SCROLL:
                const { from, to } = args;
                return driver.performTouch([
                    { action: 'press', options: { x: from.x, y: from.y } },
                    { action: 'wait', options: { ms: 500 } },
                    { action: 'moveTo', options: { x: to.x, y: to.y } },
                    { action: 'release', options: {} },
                ]);
            case WDAMethod.APPIUM_SETTINGS:
                return driver.updateSettings(args.options);
            case WDAMethod.SEND_KEYS:
                return driver.keys(args.keys);
            default:
                return `Unknown command: ${method}`;
        }
    }

    private async requestRemote(client: WdaHttpClient, command: ControlCenterCommand): Promise<any> {
        const method = command.getMethod();
        const args = command.getArgs();
        switch (method) {
            case WDAMethod.GET_SCREEN_WIDTH:
                return client.getScreenWidth();
            case WDAMethod.CLICK:
                return client.performTouch([{ action: 'tap', options: { x: args.x, y: args.y } }]);
            case WDAMethod.PRESS_BUTTON:
                return client.pressButton(args.name);
            case WDAMethod.SCROLL: {
                const { from, to } = args;
                return client.performTouch([
                    { action: 'press', options: { x: from.x, y: from.y } },
                    { action: 'wait', options: { ms: 500 } },
                    { action: 'moveTo', options: { x: to.x, y: to.y } },
                    { action: 'release', options: {} },
                ]);
            }
            case WDAMethod.APPIUM_SETTINGS:
                return client.updateSettings(args.options);
            case WDAMethod.SEND_KEYS:
                return client.sendKeys(args.keys);
            default:
                return `Unknown command: ${method}`;
        }
    }

    public async start(): Promise<void> {
        if (this.started || this.starting) {
            return;
        }
        this.emit('status-change', { status: WdaStatus.STARTING });
        this.starting = true;
        const remoteWdaUrl = ControlCenter.getInstance().getWdaUrl(this.udid);
        try {
            if (remoteWdaUrl) {
                await this.startRemote(remoteWdaUrl);
            } else {
                const server = await WdaRunner.getServer(this.udid);
                await this.startLocal(server);
                this.server = server;
            }
            this.started = true;
            this.emit('status-change', { status: WdaStatus.STARTED });
        } catch (error: any) {
            this.started = false;
            this.starting = false;
            // Node's EventEmitter throws synchronously when 'error' is emitted with no listener
            // attached (e.g. nothing has requested this WDA session yet) — crashing the whole
            // process. Fall back to just logging in that case instead of letting it throw.
            if (this.listenerCount('error') > 0) {
                this.emit('error', error);
            } else {
                console.error(this.name, `Failed to start: ${error.message}`);
            }
        }
    }

    // Device's WDA is already built/running elsewhere (e.g. on a host with Xcode) and reachable
    // through `remoteWdaUrl` (e.g. an SSH-tunneled port); talk to WDA's own REST API directly,
    // instead of appium-xcuitest-driver's `createSession()`, which always runs a local
    // `determineDevice()` check that requires Xcode/usbmuxd tooling this host doesn't have.
    private async startRemote(remoteWdaUrl: string): Promise<void> {
        const client = new WdaHttpClient(remoteWdaUrl);
        await client.createSession(this.udid);
        this.remoteClient = client;
        // MJPEG bytes still need a network path from this host to the device; since there's no
        // local xcodebuild/usbmuxd session to forward them, rely on a manually-tunneled local port
        // (e.g. a second iproxy + SSH port-forward) configured per-device via `mjpegLocalPort`.
        const mjpegLocalPort = ControlCenter.getInstance().getMjpegLocalPort(this.udid);
        if (mjpegLocalPort) {
            this.mjpegServerPort = mjpegLocalPort;
        }
        this.starting = false;
    }

    private async startLocal(server: Server): Promise<void> {
        const remoteMjpegServerPort = MJPEG_SERVER_PORT;
        const ports = await Promise.all([portfinder.getPortPromise(), portfinder.getPortPromise()]);
        this.wdaLocalPort = ports[0];
        this.mjpegServerPort = ports[1];
        await server.driver.createSession({
            platformName: 'iOS',
            deviceName: 'my iphone',
            udid: this.udid,
            wdaLocalPort: this.wdaLocalPort,
            usePrebuiltWDA: true,
            mjpegServerPort: remoteMjpegServerPort,
        });
        await server.driver.wda.xcodebuild.waitForStart(new timing.Timer().start());
        if (server.driver?.wda?.xcodebuild?.xcodebuild) {
            server.driver.wda.xcodebuild.xcodebuild.on('exit', (code: number) => {
                this.started = false;
                this.starting = false;
                server.driver.deleteSession();
                delete this.server;
                this.emit('status-change', { status: WdaStatus.STOPPED, code });
                if (this.holders > 0) {
                    this.start();
                }
            });
        } else {
            this.started = false;
            this.starting = false;
            delete this.server;
            throw new Error('xcodebuild process not found');
        }
        /// #if USE_WDA_MJPEG_SERVER
        const { DEVICE_CONNECTIONS_FACTORY } = await import(
            'appium-xcuitest-driver/build/lib/device-connections-factory'
        );

        await DEVICE_CONNECTIONS_FACTORY.requestConnection(this.udid, this.mjpegServerPort, {
            usePortForwarding: true,
            devicePort: remoteMjpegServerPort,
        });
        /// #endif
    }

    public isStarted(): boolean {
        return this.started;
    }

    public release(): void {
        this.unlock();
    }
}
