import '../../LICENSE';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Config } from './Config';
import { HttpServer } from './services/HttpServer';
import { WebSocketServer } from './services/WebSocketServer';
import { Service, ServiceClass } from './services/Service';
import { MwFactory } from './mw/Mw';
import { WebsocketProxy } from './mw/WebsocketProxy';
import { HostTracker } from './mw/HostTracker';
import { WebsocketMultiplexer } from './mw/WebsocketMultiplexer';

const servicesToStart: ServiceClass[] = [HttpServer, WebSocketServer];

// MWs that accept WebSocket
const mwList: MwFactory[] = [WebsocketProxy, WebsocketMultiplexer];

// MWs that accept Multiplexer
const mw2List: MwFactory[] = [HostTracker];

const runningServices: Service[] = [];
const loadPlatformModulesPromises: Promise<void>[] = [];

const config = Config.getInstance();

function startAdbServerAllInterfaces(port?: number): void {
    // Kill any existing daemon first — 'adb -a start-server' is a no-op if one
    // is already running without the -a flag.
    spawnSync('adb', ['kill-server'], { encoding: 'utf8' });

    const args = ['-a'];
    if (typeof port === 'number') {
        args.push('-P', String(port));
    }
    args.push('start-server');
    const result = spawnSync('adb', args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        const msg = result.stderr || result.error?.message || 'Unknown adb startup error';
        console.error(`[ADB] Failed to start all-interface server: ${msg}`);
        return;
    }
    console.log('[ADB] Server configured to listen on all interfaces');
}

function isAdbListeningAllInterfaces(port: number): boolean {
    const result = spawnSync('ss', ['-ltn'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        const msg = result.stderr || result.error?.message || 'Unknown ss error';
        console.error(`[ADB] Failed to inspect listening sockets: ${msg}`);
        return false;
    }

    const lines = result.stdout.split('\n');
    const hasPort = new RegExp(`:${port}\\b`);
    const allIfaces = new RegExp(`(?:\\*:${port}\\b|0\\.0\\.0\\.0:${port}\\b|\\[::\\]:${port}\\b)`);

    for (const line of lines) {
        if (!line.includes('LISTEN')) {
            continue;
        }
        if (!hasPort.test(line)) {
            continue;
        }
        if (allIfaces.test(line)) {
            return true;
        }
    }

    return false;
}

function ensureAdbServerAllInterfaces(port: number): void {
    if (!isAdbListeningAllInterfaces(port)) {
        console.warn(`[ADB] Port ${port} is not exposed on all interfaces. Restarting daemon with -a`);
        startAdbServerAllInterfaces(port);
    }
}

function installAdbAllInterfacesWrapper(): string {
    const wrapperPath = path.join(os.tmpdir(), 'ws-scrcpy-adb-wrapper.sh');
    const content = [
        '#!/bin/sh',
        '# ws-scrcpy wrapper: ensures adb start-server always uses -a (all interfaces)',
        'for arg in "$@"; do',
        '  if [ "$arg" = "start-server" ]; then',
        '    exec adb -a "$@"',
        '  fi',
        'done',
        'exec adb "$@"',
        '',
    ].join('\n');
    fs.writeFileSync(wrapperPath, content, { mode: 0o755 });
    return wrapperPath;
}

/// #if INCLUDE_GOOG
async function loadGoogModules() {
    if (config.adbListenAllInterfaces) {
        startAdbServerAllInterfaces(config.adbPort);
        const adbPort = typeof config.adbPort === 'number' ? config.adbPort : 5037;
        ensureAdbServerAllInterfaces(adbPort);
        const timer = setInterval(() => {
            ensureAdbServerAllInterfaces(adbPort);
        }, 30000);
        timer.unref();
    }
    const { AdbExtended } = await import('./goog-device/adb');
    const adbOptions: { host?: string; port?: number; bin?: string } = {};
    if (config.adbHost) {
        adbOptions.host = config.adbHost;
    }
    if (config.adbPort) {
        adbOptions.port = config.adbPort;
    }
    if (config.adbListenAllInterfaces) {
        adbOptions.bin = installAdbAllInterfacesWrapper();
    }
    AdbExtended.setDefaultOptions(adbOptions);

    const { ControlCenter } = await import('./goog-device/services/ControlCenter');
    const { DeviceTracker } = await import('./goog-device/mw/DeviceTracker');
    const { WebsocketProxyOverAdb } = await import('./goog-device/mw/WebsocketProxyOverAdb');

    if (config.runLocalGoogTracker) {
        mw2List.push(DeviceTracker);
    }

    if (config.announceLocalGoogTracker) {
        HostTracker.registerLocalTracker(DeviceTracker);
    }

    servicesToStart.push(ControlCenter);

    /// #if INCLUDE_ADB_SHELL
    const { RemoteShell } = await import('./goog-device/mw/RemoteShell');
    mw2List.push(RemoteShell);
    /// #endif

    /// #if INCLUDE_DEV_TOOLS
    const { RemoteDevtools } = await import('./goog-device/mw/RemoteDevtools');
    mwList.push(RemoteDevtools);
    /// #endif

    /// #if INCLUDE_FILE_LISTING
    const { FileListing } = await import('./goog-device/mw/FileListing');
    mw2List.push(FileListing);
    /// #endif

    mwList.push(WebsocketProxyOverAdb);
}
loadPlatformModulesPromises.push(loadGoogModules());
/// #endif

/// #if INCLUDE_APPL
async function loadApplModules() {
    const { ControlCenter } = await import('./appl-device/services/ControlCenter');
    const { DeviceTracker } = await import('./appl-device/mw/DeviceTracker');
    const { WebDriverAgentProxy } = await import('./appl-device/mw/WebDriverAgentProxy');

    // Hack to reduce log-level of appium libs
    const { default: npmlog } = await import('npmlog');
    npmlog.level = 'warn';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any)._global_npmlog = npmlog;

    if (config.runLocalApplTracker) {
        mw2List.push(DeviceTracker);
    }

    if (config.announceLocalApplTracker) {
        HostTracker.registerLocalTracker(DeviceTracker);
    }

    servicesToStart.push(ControlCenter);

    /// #if USE_QVH_SERVER
    const { QVHStreamProxy } = await import('./appl-device/mw/QVHStreamProxy');
    mw2List.push(QVHStreamProxy);
    /// #endif
    mw2List.push(WebDriverAgentProxy);
}
loadPlatformModulesPromises.push(loadApplModules());
/// #endif

Promise.all(loadPlatformModulesPromises)
    .then(() => {
        return servicesToStart.map((serviceClass: ServiceClass) => {
            const service = serviceClass.getInstance();
            runningServices.push(service);
            return service.start();
        });
    })
    .then(() => {
        const wsService = WebSocketServer.getInstance();
        mwList.forEach((mwFactory: MwFactory) => {
            wsService.registerMw(mwFactory);
        });

        mw2List.forEach((mwFactory: MwFactory) => {
            WebsocketMultiplexer.registerMw(mwFactory);
        });

        if (process.platform === 'win32') {
            readline
                .createInterface({
                    input: process.stdin,
                    output: process.stdout,
                })
                .on('SIGINT', exit);
        }

        process.on('SIGINT', exit);
        process.on('SIGTERM', exit);
    })
    .catch((error) => {
        console.error(error.message);
        exit('1');
    });

let interrupted = false;
function exit(signal: string) {
    console.log(`\nReceived signal ${signal}`);
    if (interrupted) {
        console.log('Force exit');
        process.exit(0);
        return;
    }
    interrupted = true;
    runningServices.forEach((service: Service) => {
        const serviceName = service.getName();
        console.log(`Stopping ${serviceName} ...`);
        service.release();
    });
}
