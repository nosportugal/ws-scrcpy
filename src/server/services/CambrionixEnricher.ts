/**
 * CambrionixEnricher
 *
 * Polls one or more Cambrionix Hub Manager REST APIs and provides per-device
 * enrichment data (hub, port, power state, connection state).
 *
 * Design notes:
 * - Each source is polled independently; failure of one never affects the other.
 * - Results are cached per source.  A stale cache is used until a fresh one is
 *   available (degraded-but-live behaviour).
 * - `enrich(udid)` returns the first match across all enabled sources (priority:
 *   source order in config).  The `cambrionix.source` field records which hub
 *   provided the data for auditability.
 * - If no sources are configured or none match, `enrich` returns undefined so
 *   callers can leave native device data untouched.
 */

import * as http from 'http';
import * as https from 'https';
import { CambrionixSourceConfig } from '../../types/Configuration';
import { CambrionixInfo } from '../../types/BaseDeviceDescriptor';

// ---------------------------------------------------------------------------
// Cambrionix API types (Hub Manager REST API)
// ---------------------------------------------------------------------------

interface CambrionixPort {
    port?: number;
    /** Serial number / UDID of the attached device (key varies by firmware). */
    serial_number?: string;
    serialNumber?: string;
    serial?: string;
    /** Power mode: "auto", "on", "off", "sync", etc. */
    mode?: string;
    state?: string;
    /** Connection state: "connected", "disconnected", etc. */
    connection?: string;
    connection_status?: string;
}

interface CambrionixApiResponse {
    /** Most firmware versions wrap ports in a `ports` array. */
    ports?: CambrionixPort[];
    /** Some return an array directly at root. */
    [index: number]: CambrionixPort | undefined;
    length?: number;
}

// ---------------------------------------------------------------------------
// Internal per-source state
// ---------------------------------------------------------------------------

interface SourceState {
    label: string;
    config: Required<CambrionixSourceConfig>;
    /** Last successfully parsed port list, keyed by normalised serial. */
    cache: Map<string, CambrionixPort & { portNumber: number }>;
    /** Timestamp of last successful fetch. */
    cacheAt: number;
    /** Whether a fetch is currently in progress (guards against concurrency). */
    fetching: boolean;
    pollTimer?: ReturnType<typeof setTimeout>;
    /** Simple metrics. */
    metrics: {
        totalFetches: number;
        successFetches: number;
        errorFetches: number;
        lastLatencyMs: number;
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseSerial(s: string): string {
    return s.trim().toLowerCase();
}

function resolveSerial(port: CambrionixPort): string | undefined {
    const raw = port.serial_number ?? port.serialNumber ?? port.serial;
    if (!raw || raw.trim() === '') {
        return undefined;
    }
    return normaliseSerial(raw);
}

function resolvePort(port: CambrionixPort, index: number): number {
    return typeof port.port === 'number' ? port.port : index + 1;
}

function resolvePowerState(port: CambrionixPort): string {
    return port.mode ?? port.state ?? 'unknown';
}

function resolveConnectionState(port: CambrionixPort): string {
    return port.connection ?? port.connection_status ?? 'unknown';
}

/**
 * Issue an HTTP(S) GET request and resolve with the body string.
 * Rejects on error, bad status code, or timeout.
 */
function httpGet(url: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { timeout: timeoutMs }, (res) => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode} from ${url}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
        });
    });
}

// ---------------------------------------------------------------------------
// CambrionixEnricher
// ---------------------------------------------------------------------------

export class CambrionixEnricher {
    private static instance?: CambrionixEnricher;

    private readonly sources: SourceState[] = [];

    private constructor(configs: CambrionixSourceConfig[]) {
        configs.forEach((cfg, idx) => {
            if (cfg.enable === false) {
                const label = cfg.name ?? `cambrionix-${idx}`;
                console.log(`[Cambrionix][${label}] Source disabled — skipping`);
                return;
            }
            const label = cfg.name ?? `cambrionix-${idx}`;
            const resolved: Required<CambrionixSourceConfig> = {
                name: label,
                enable: true as boolean,
                baseUrl: cfg.baseUrl.replace(/\/$/, ''),
                path: cfg.path ?? '/api/v1/port',
                timeoutMs: cfg.timeoutMs ?? 5000,
                retryDelayMs: cfg.retryDelayMs ?? 10000,
                cacheMs: cfg.cacheMs ?? 30000,
                pollMs: cfg.pollMs ?? 20000,
            };
            const state: SourceState = {
                label,
                config: resolved,
                cache: new Map(),
                cacheAt: 0,
                fetching: false,
                metrics: { totalFetches: 0, successFetches: 0, errorFetches: 0, lastLatencyMs: 0 },
            };
            this.sources.push(state);
        });
    }

    public static getInstance(configs?: CambrionixSourceConfig[]): CambrionixEnricher {
        if (!this.instance) {
            this.instance = new CambrionixEnricher(configs ?? []);
        }
        return this.instance;
    }

    /** Reset singleton — used when re-configuring (e.g. in tests). */
    public static reset(): void {
        if (this.instance) {
            this.instance.stop();
            this.instance = undefined;
        }
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /** Start background polling for all enabled sources. */
    public start(): void {
        for (const src of this.sources) {
            console.log(`[Cambrionix][${src.label}] Starting enrichment source → ${src.config.baseUrl}${src.config.path}`);
            this.schedulePoll(src, 0);
        }
    }

    /** Stop all timers. */
    public stop(): void {
        for (const src of this.sources) {
            if (src.pollTimer) {
                clearTimeout(src.pollTimer);
                src.pollTimer = undefined;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Polling
    // -----------------------------------------------------------------------

    private schedulePoll(src: SourceState, delayMs: number): void {
        src.pollTimer = setTimeout(() => this.poll(src), delayMs);
    }

    private async poll(src: SourceState): Promise<void> {
        if (src.fetching) {
            // Already in-flight; reschedule without starting a duplicate.
            this.schedulePoll(src, src.config.pollMs);
            return;
        }
        src.fetching = true;
        const url = `${src.config.baseUrl}${src.config.path}`;
        const t0 = Date.now();
        src.metrics.totalFetches++;
        try {
            const body = await httpGet(url, src.config.timeoutMs);
            const latency = Date.now() - t0;
            src.metrics.lastLatencyMs = latency;
            const parsed: CambrionixApiResponse = JSON.parse(body);
            const ports: CambrionixPort[] = Array.isArray(parsed) ? parsed : (parsed.ports ?? []);
            const newCache: Map<string, CambrionixPort & { portNumber: number }> = new Map();
            ports.forEach((p, i) => {
                const serial = resolveSerial(p);
                if (serial) {
                    newCache.set(serial, { ...p, portNumber: resolvePort(p, i) });
                }
            });
            src.cache = newCache;
            src.cacheAt = Date.now();
            src.metrics.successFetches++;
            console.log(`[Cambrionix][${src.label}] Refreshed — ${newCache.size} device(s) indexed (${latency}ms)`);
            this.schedulePoll(src, src.config.pollMs);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            src.metrics.errorFetches++;
            const stale = src.cacheAt > 0 ? ` (using stale cache from ${Math.round((Date.now() - src.cacheAt) / 1000)}s ago)` : ' (no cache available)';
            console.warn(`[Cambrionix][${src.label}] Fetch error: ${msg}${stale}`);
            this.schedulePoll(src, src.config.retryDelayMs);
        } finally {
            src.fetching = false;
        }
    }

    // -----------------------------------------------------------------------
    // Enrichment
    // -----------------------------------------------------------------------

    /**
     * Return Cambrionix enrichment for `udid`, or `undefined` if no source
     * has a matching entry.  Sources are tried in config order; first match wins.
     */
    public enrich(udid: string): CambrionixInfo | undefined {
        const normUdid = normaliseSerial(udid);
        for (const src of this.sources) {
            const entry = src.cache.get(normUdid);
            if (!entry) {
                continue;
            }
            const hubLabel = src.config.name ?? src.label;
            console.debug(`[Cambrionix][${src.label}] Match for ${udid} → port ${entry.portNumber}`);
            return {
                source: hubLabel,
                port: entry.portNumber,
                powerState: resolvePowerState(entry),
                connectionState: resolveConnectionState(entry),
            };
        }
        return undefined;
    }

    // -----------------------------------------------------------------------
    // Observability
    // -----------------------------------------------------------------------

    /** Returns a snapshot of per-source metrics for diagnostics. */
    public getMetrics(): Record<string, { totalFetches: number; successFetches: number; errorFetches: number; lastLatencyMs: number; cachedDevices: number; cacheAgeMs: number }> {
        const result: Record<string, ReturnType<CambrionixEnricher['getMetrics']>[string]> = {};
        for (const src of this.sources) {
            result[src.label] = {
                ...src.metrics,
                cachedDevices: src.cache.size,
                cacheAgeMs: src.cacheAt > 0 ? Date.now() - src.cacheAt : -1,
            };
        }
        return result;
    }

    public isActive(): boolean {
        return this.sources.length > 0;
    }
}
