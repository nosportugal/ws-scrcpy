import * as http from 'http';

// Minimal client for WDA's own REST API, used instead of appium-xcuitest-driver's
// `XCUITestDriver` for remote sessions: that driver's `createSession()` always runs a local
// `determineDevice()` check that shells out to Xcode/usbmuxd tooling, which isn't available
// on a host with no local USB/Xcode access to the device.
export class WdaHttpClient {
    private sessionId?: string;

    constructor(private readonly baseUrl: string) {}

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

    public async createSession(udid: string): Promise<void> {
        const response = await this.request<{ value: { sessionId: string } }>('POST', '/session', {
            capabilities: {
                alwaysMatch: { platformName: 'iOS', 'appium:udid': udid },
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

    public performTouch(gestures: { action: string; options: Record<string, unknown> }[]): Promise<any> {
        return this.request('POST', `/session/${this.requireSession()}/wda/touch/perform`, { actions: gestures });
    }

    public pressButton(name: string): Promise<any> {
        return this.request('POST', `/session/${this.requireSession()}/wda/pressButton`, { name });
    }

    public sendKeys(value: string): Promise<any> {
        return this.request('POST', `/session/${this.requireSession()}/wda/keys`, { value: value.split('') });
    }

    public updateSettings(settings: Record<string, unknown>): Promise<any> {
        return this.request('POST', `/session/${this.requireSession()}/appium/settings`, { settings });
    }

    public async getScreenWidth(): Promise<number> {
        const response = await this.request<{ value?: { statusBarSize?: { width: number } } }>(
            'GET',
            `/session/${this.requireSession()}/wda/screen`,
        );
        return response.value?.statusBarSize?.width || 0;
    }

    public deleteSession(): Promise<any> {
        if (!this.sessionId) {
            return Promise.resolve();
        }
        return this.request('DELETE', `/session/${this.sessionId}`);
    }
}
