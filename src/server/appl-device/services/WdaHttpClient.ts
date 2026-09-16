import * as http from 'http';

// Minimal client for WDA's own REST API, used instead of appium-xcuitest-driver's
// `XCUITestDriver` for remote sessions: that driver's `createSession()` always runs a local
// `determineDevice()` check that shells out to Xcode/usbmuxd tooling, which isn't available
// on a host with no local USB/Xcode access to the device.
export class WdaHttpClient {
    private sessionId?: string;

    constructor(private readonly baseUrl: string) {}

    public async findSession(udid: string): Promise<string | undefined> {
        const response = await this.request<{
            value: Array<{ id?: string; sessionId?: string; capabilities?: { udid?: string } }>;
        }>('GET', '/sessions');
        const session = response.value?.find((item) => item.capabilities?.udid === udid);
        return session?.id || session?.sessionId;
    }

    public adoptSession(sessionId: string): void {
        this.sessionId = sessionId;
    }

    public async isSessionAlive(): Promise<boolean> {
        if (!this.sessionId) {
            return false;
        }
        try {
            await this.request('GET', `/session/${this.sessionId}/window/rect`);
            return true;
        } catch {
            return false;
        }
    }

    private request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
        return new Promise((resolve, reject) => {
            const url = new URL(path, this.baseUrl);
            const data = body !== undefined ? JSON.stringify(body) : undefined;
            const req = http.request(
                {
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname,
                    method,
                    headers: data
                        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
                        : undefined,
                },
                (res) => {
                    let raw = '';
                    res.on('data', (chunk) => (raw += chunk));
                    res.on('end', () => {
                        if (!res.statusCode || res.statusCode >= 400) {
                            reject(new Error(`WDA request failed: ${method} ${path} -> ${res.statusCode}: ${raw}`));
                            return;
                        }
                        try {
                            resolve(raw ? JSON.parse(raw) : (undefined as unknown as T));
                        } catch (e) {
                            reject(e);
                        }
                    });
                },
            );
            req.on('error', reject);
            if (data) {
                req.write(data);
            }
            req.end();
        });
    }

    public async createSession(
        udid: string,
        signingCapabilities: Record<string, string | number | undefined> = {},
    ): Promise<void> {
        const signingCaps: Record<string, string | number> = Object.keys(signingCapabilities).reduce((acc, key) => {
            const value = signingCapabilities[key];
            if (value !== undefined) {
                acc[key] = value;
            }
            return acc;
        }, {} as Record<string, string | number>);

        const response = await this.request<{ value: { sessionId: string } }>('POST', '/session', {
            capabilities: {
                alwaysMatch: {
                    platformName: 'iOS',
                    'appium:automationName': 'XCUITest',
                    'appium:udid': udid,
                    'appium:mjpegServerPort': 9100,
                    'appium:newCommandTimeout': 3600,
                    'appium:wdaConnectionTimeout': 120000,
                    'appium:wdaStartupRetries': 3,
                    'appium:wdaStartupRetryInterval': 5000,
                    ...signingCaps,
                },
                firstMatch: [{}],
            },
        });
        this.sessionId = response.value.sessionId;
    }

    private requireSession(): string {
        if (!this.sessionId) {
            throw new Error('WDA session not started');
        }
        return this.sessionId;
    }

    public getDeviceInfo(): Promise<{ name?: string; model?: string; osVersion?: string; productVersion?: string }> {
        return this.executeMobile('deviceInfo');
    }

    // Appium (unlike raw WDA) doesn't proxy `/wda/...` paths directly; XCUITest-specific
    // gestures/commands must go through the standard `execute/sync` endpoint as `mobile: <name>`.
    private async executeMobile<T = any>(command: string, args: Record<string, unknown> = {}): Promise<T> {
        const response = await this.request<{ value: T }>(
            'POST',
            `/session/${this.requireSession()}/execute/sync`,
            { script: `mobile: ${command}`, args: [args] },
        );
        return response.value;
    }

    public tap(x: number, y: number): Promise<any> {
        return this.executeMobile('tap', { x, y });
    }

    public dragFromToForDuration(fromX: number, fromY: number, toX: number, toY: number, duration = 0.5): Promise<any> {
        return this.executeMobile('dragFromToForDuration', { fromX, fromY, toX, toY, duration });
    }

    public pressButton(name: string): Promise<any> {
        return this.executeMobile('pressButton', { name });
    }

    public sendKeys(value: string): Promise<any> {
        // `mobile: type` isn't a real XCUITest execute-method (NotImplementedError); the classic
        // `/keys` endpoint (proxied by Appium to WDA's `/wda/keys`) works on iPhone and iPad.
        return this.request('POST', `/session/${this.requireSession()}/keys`, { value: [...value] });
    }

    public updateSettings(settings: Record<string, unknown>): Promise<any> {
        return this.request('POST', `/session/${this.requireSession()}/appium/settings`, { settings });
    }

    public async getScreenWidth(): Promise<number> {
        const response = await this.request<{ value?: { width?: number } }>(
            'GET',
            `/session/${this.requireSession()}/window/rect`,
        );
        return response.value?.width || 0;
    }

    public async getWindowSize(): Promise<{ width: number; height: number }> {
        const response = await this.request<{ value?: { width?: number; height?: number } }>(
            'GET',
            `/session/${this.requireSession()}/window/rect`,
        );
        return { width: response.value?.width || 0, height: response.value?.height || 0 };
    }

    public deleteSession(): Promise<any> {
        if (!this.sessionId) {
            return Promise.resolve();
        }
        const sessionId = this.sessionId;
        this.sessionId = undefined;
        return this.request('DELETE', `/session/${sessionId}`).catch(() => undefined);
    }
}
