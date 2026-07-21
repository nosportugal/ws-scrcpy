export class DeviceLock {
  private locks: Map<string, {
    sessionId: string;
    ws: any;
    lastActive: number;
  }> = new Map();
  private listeners: Set<() => void> = new Set();

  private timeoutMs: number;
  public onUpdate: (() => void) | null = null;

  constructor(timeoutMs = 5 * 60 * 1000) {
    this.timeoutMs = timeoutMs;

    setInterval(() => this.cleanup(), 10000);
  }

  lockDevice(deviceId: string, sessionId: string, ws: any): boolean {
    const existing = this.locks.get(deviceId);

    if (existing?.ws && existing.ws.readyState !== 3) {
      return false;
    }

    this.locks.set(deviceId, { sessionId, ws, lastActive: Date.now() });
    this.notifyUpdate();
    return true;
  }

  refresh(deviceId: string, sessionId: string): void {
    const lock = this.locks.get(deviceId);
    if (lock && lock.sessionId === sessionId) {
      lock.lastActive = Date.now();
    }
  }

  unlock(deviceId: string, sessionId: string): void {
    const lock = this.locks.get(deviceId);
    if (!lock) return;

    if (lock.sessionId === sessionId) {
      this.locks.delete(deviceId);
      this.notifyUpdate();
    }
  }

  private cleanup() {
    const now = Date.now();

    for (const [deviceId, lock] of this.locks.entries()) {
      const wsDead = lock.ws.readyState === 3;
      const expired = now - lock.lastActive > this.timeoutMs;

      if (expired || wsDead) {
        try { lock.ws.close(); } catch {}
        this.locks.delete(deviceId);
        this.notifyUpdate();
      }
    }
  }

  listActive() {
    return Array.from(this.locks.entries()).map(([deviceId, lock]) => ({
      deviceId,
      sessionId: lock.sessionId,
      lastActive: lock.lastActive
    }));
  }

  isLocked(deviceId: string): boolean {
    const lock = this.locks.get(deviceId);
    if (!lock) {
      return false;
    }
    return lock.ws?.readyState !== 3;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyUpdate(): void {
    this.onUpdate?.();
    for (const listener of this.listeners.values()) {
      try {
        listener();
      } catch {
        // Ignore listener errors to avoid breaking lock updates.
      }
    }
  }
}

export default new DeviceLock();
