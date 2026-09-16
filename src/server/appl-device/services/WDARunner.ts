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
    private startPromise?: Promise<void>;

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
            case WDAMethod.EDGE_SWIPE_BACK:
                return driver.performTouch([
                    { action: 'press', options: { x: 2, y: 300 } },
                    { action: 'wait', options: { ms: 100 } },
                    { action: 'moveTo', options: { x: 150, y: 300 } },
                    { action: 'release', options: {} },
                ]);
            default:
                return `Unknown command: ${method}`;
        }
    }

    private async requestRemote(
        client: WdaHttpClient,
        command: ControlCenterCommand,
        allowRecovery = true,
    ): Promise<any> {
        const method = command.getMethod();
        const args = command.getArgs();
        try {
            switch (method) {
                case WDAMethod.GET_SCREEN_WIDTH:
                    return client.getScreenWidth();
                case WDAMethod.CLICK:
                    return client.tap(args.x, args.y);
                case WDAMethod.PRESS_BUTTON:
                    return client.pressButton(args.name);
                case WDAMethod.SCROLL: {
                    const { from, to } = args;
                    return client.dragFromToForDuration(from.x, from.y, to.x, to.y);
                }
                case WDAMethod.APPIUM_SETTINGS:
                    return client.updateSettings(args.options);
                case WDAMethod.SEND_KEYS:
                    return client.sendKeys(args.keys);
                case WDAMethod.EDGE_SWIPE_BACK:
                    // Common iOS "back" gesture: swipe in from the left edge of the screen.
                    return client.dragFromToForDuration(2, 300, 150, 300, 0.3);
                default:
                    return `Unknown command: ${method}`;
            }
        } catch (error: any) {
            if (!allowRecovery || !this.isRemoteWdaFailure(error)) {
                throw error;
            }
            console.warn(this.name, `Remote WDA failed; recreating session: ${error.message}`);
            if (this.remoteClient === client) {
                this.remoteClient = undefined;
                this.started = false;
            }
            await client.deleteSession();
            await this.start();
            if (!this.remoteClient) {
                throw error;
            }
            return this.requestRemote(this.remoteClient, command, false);
        }
    }

    private isRemoteWdaFailure(error: Error): boolean {
        return /ECONNREFUSED|socket hang up|invalid session id|Could not proxy command/i.test(error.message);
    }

    public async start(): Promise<void> {
        if (this.started) {
            if (!this.remoteClient || (await this.remoteClient.isSessionAlive())) {
                return;
            }
            await this.remoteClient.deleteSession();
            this.remoteClient = undefined;
            this.started = false;
        }
        if (this.startPromise) {
            return this.startPromise;
        }
        this.startPromise = this.startInternal().finally(() => {
            this.startPromise = undefined;
        });
        return this.startPromise;
    }

    private async startInternal(): Promise<void> {
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
            this.starting = false;
            this.emit('status-change', { status: WdaStatus.STARTED });
        } catch (error: any) {
            this.started = false;
            this.starting = false;
            if (this.listenerCount('error') > 0) {
                this.emit('error', error);
            } else {
                console.error(this.name, `Failed to start: ${error.message}`);
            }
            throw error;
        }
    }

    // Device's WDA is already built/running elsewhere (e.g. on a host with Xcode) and reachable
    // through `remoteWdaUrl` (e.g. an SSH-tunneled port); talk to WDA's own REST API directly,
    // instead of appium-xcuitest-driver's `createSession()`, which always runs a local
    // `determineDevice()` check that requires Xcode/usbmuxd tooling this host doesn't have.
    private async startRemote(remoteWdaUrl: string): Promise<void> {
        const client = new WdaHttpClient(remoteWdaUrl);
        const controlCenter = ControlCenter.getInstance();
        let existingSession: string | undefined;
        try {
            existingSession = await client.findSession(this.udid);
        } catch (error: any) {
            console.warn(this.name, `Unable to list Appium sessions: ${error.message}`);
        }
        if (existingSession) {
            client.adoptSession(existingSession);
            if (await client.isSessionAlive()) {
                this.remoteClient = client;
                await this.updateRemoteMetadata(controlCenter, client);
                this.configureRemoteMjpeg();
                return;
            }
            await client.deleteSession();
        }
        await client.createSession(this.udid, {
            'appium:updatedWDABundleId': controlCenter.getUpdatedWDABundleId(this.udid),
            'appium:xcodeOrgId': controlCenter.getXcodeOrgId(this.udid),
            'appium:xcodeSigningId': controlCenter.getXcodeSigningId(this.udid),
            'appium:wdaLocalPort': controlCenter.getWdaLocalPort(this.udid),
        });
        this.remoteClient = client;
        await this.updateRemoteMetadata(controlCenter, client);
        this.configureRemoteMjpeg();
    }

    private async updateRemoteMetadata(controlCenter: ControlCenter, client: WdaHttpClient): Promise<void> {
        try {
            controlCenter.updateDeviceInfo(this.udid, await client.getDeviceInfo());
        } catch (error: any) {
            console.warn(this.name, `Unable to read device metadata: ${error.message}`);
        }
    }

    private configureRemoteMjpeg(): void {
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
