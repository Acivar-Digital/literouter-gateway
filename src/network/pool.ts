import { EventEmitter } from "node:events";
import type { ProviderCode } from "../directive/parser";
import { CooldownManager, type KeyCooldownState } from "./cooldown";
import { getProviderConfig } from "../config/providers";

export interface SelectedKey {
  readonly key: string;
  readonly index: number;
  readonly totalKeys: number;
}

export interface PoolStatus {
  readonly total: number;
  readonly active: number;
  readonly quarantined: number;
}

const DEFAULT_SESSION_PIN_TTL_MS = 300_000;
const DEFAULT_SESSION_PIN_MAX_ENTRIES = 2_000;

export interface SessionPinOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

interface SessionPin {
  keyIndex: number;
  expiresAt: number;
}

export class FatalAuthError extends Error {
  public readonly status: number;
  public readonly provider: string;
  public readonly keyIndex: number;
  public readonly isFatal = true;

  constructor(provider: string, keyIndex: number, status: number, body?: string) {
    super(
      `Fatal authentication failure (HTTP ${status}) for provider "${provider}" key index ${keyIndex}: rejecting immediately with zero retry.`
    );
    this.name = "FatalAuthError";
    this.status = status;
    this.provider = provider;
    this.keyIndex = keyIndex;
  }
}

export function isFatalAuthError(err: unknown): err is FatalAuthError {
  return err instanceof FatalAuthError || (err instanceof Error && err.name === "FatalAuthError");
}

export function isProviderQuarantineEnabled(provider: string): boolean {
  try {
    const provConfig = getProviderConfig(provider) as { key_cooldown?: { enabled?: boolean } };
    const norm = provider.toLowerCase();
    const defaultEnabled = norm === "zn" || norm === "gc" ? false : true;
    return provConfig.key_cooldown?.enabled ?? defaultEnabled;
  } catch {
    return true;
  }
}

export class KeyPool extends EventEmitter {
  private readonly pools = new Map<string, readonly string[]>();
  private readonly pointers = new Map<string, number>();
  private readonly activeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cooldownManager: CooldownManager;
  private readonly sessionPins = new Map<string, SessionPin>();
  private readonly sessionPinTtlMs: number;
  private readonly sessionPinMaxEntries: number;

  public constructor(cooldownManager?: CooldownManager, options?: SessionPinOptions) {
    super();
    this.cooldownManager = cooldownManager ?? new CooldownManager();
    this.sessionPinTtlMs = options?.ttlMs ?? DEFAULT_SESSION_PIN_TTL_MS;
    this.sessionPinMaxEntries = options?.maxEntries ?? DEFAULT_SESSION_PIN_MAX_ENTRIES;
  }

  public setPool(provider: ProviderCode | string, keys: readonly string[]): void {
    this.pools.set(provider, Object.freeze([...keys]));
    if (!this.pointers.has(provider)) {
      this.pointers.set(provider, 0);
    }
  }

  public getCooldownManager(): CooldownManager {
    return this.cooldownManager;
  }

  private makeKeyId(provider: string, index: number): string {
    return `${provider}:${index}`;
  }

  private makeSessionPinId(provider: string, sessionId: string): string {
    return `${provider}:${sessionId}`;
  }

  private getKeys(provider: string): readonly string[] {
    return this.pools.get(provider) ?? [];
  }

  public isQuarantineEnabled(provider: string): boolean {
    return isProviderQuarantineEnabled(provider);
  }

  private isKeyAvailable(provider: string, index: number, total: number, now: number): boolean {
    if (index < 0 || index >= total) {
      return false;
    }
    if (!this.isQuarantineEnabled(provider)) {
      return true;
    }
    return !this.cooldownManager.isQuarantined(this.makeKeyId(provider, index), now);
  }

  private tryPickIndex(
    provider: string,
    idx: number,
    keys: readonly string[],
    now: number
  ): SelectedKey | null {
    const keyId = this.makeKeyId(provider, idx);
    if (this.isQuarantineEnabled(provider) && this.cooldownManager.isQuarantined(keyId, now)) {
      return null;
    }
    const key = keys[idx];
    if (key === undefined) {
      return null;
    }
    this.pointers.set(provider, (idx + 1) % keys.length);
    return { key, index: idx, totalKeys: keys.length };
  }

  private evictOldestSessionPin(): void {
    const oldest = this.sessionPins.keys().next();
    if (!oldest.done) {
      this.sessionPins.delete(oldest.value);
    }
  }

  private pinSessionKey(provider: string, sessionId: string, keyIndex: number, now: number): void {
    const pinId = this.makeSessionPinId(provider, sessionId);
    const isNew = !this.sessionPins.has(pinId);
    // Refreshing an existing pin must move it to the most-recently-used end, so
    // delete first: a plain re-set would keep its old insertion slot and let
    // evictOldestSessionPin evict by insertion order (FIFO) instead of true LRU.
    this.sessionPins.delete(pinId);
    if (isNew && this.sessionPins.size >= this.sessionPinMaxEntries) {
      this.evictOldestSessionPin();
    }
    this.sessionPins.set(pinId, { keyIndex, expiresAt: now + this.sessionPinTtlMs });
  }

  private getPinnedKey(provider: string, sessionId: string, total: number, now: number): SelectedKey | null {
    const pinId = this.makeSessionPinId(provider, sessionId);
    const pin = this.sessionPins.get(pinId);
    if (pin === undefined) {
      return null;
    }
    if (pin.expiresAt <= now) {
      // Purge the stale entry so an expired pin does not leak until eviction.
      this.sessionPins.delete(pinId);
      return null;
    }
    if (!this.isKeyAvailable(provider, pin.keyIndex, total, now)) {
      return null;
    }
    const key = this.getKeys(provider)[pin.keyIndex];
    if (key === undefined) {
      return null;
    }
    // A live hit refreshes both recency and TTL: delete-then-set moves the pin
    // to the most-recently-used end of the eviction order.
    this.sessionPins.delete(pinId);
    this.sessionPins.set(pinId, { keyIndex: pin.keyIndex, expiresAt: now + this.sessionPinTtlMs });
    return { key, index: pin.keyIndex, totalKeys: total };
  }

  private invalidateSessionPins(provider: string, index: number): void {
    const prefix = `${provider}:`;
    for (const [pinId, pin] of this.sessionPins) {
      if (pinId.startsWith(prefix) && pin.keyIndex === index) {
        this.sessionPins.delete(pinId);
      }
    }
  }

  private selectRoundRobinKey(provider: string, now: number): SelectedKey | null {
    const keys = this.getKeys(provider);
    const total = keys.length;
    const startIndex = this.pointers.get(provider) ?? 0;
    for (let offset = 0; offset < total; offset += 1) {
      const picked = this.tryPickIndex(provider, (startIndex + offset) % total, keys, now);
      if (picked !== null) {
        return picked;
      }
    }
    return null;
  }

  public selectNextKey(
    provider: ProviderCode | string,
    now: number = Date.now(),
    sessionId?: string
  ): SelectedKey | null {
    const total = this.getKeys(provider).length;
    if (total === 0) {
      return null;
    }
    if (sessionId !== undefined) {
      const pinned = this.getPinnedKey(provider, sessionId, total, now);
      if (pinned !== null) {
        return pinned;
      }
    }
    const selected = this.selectRoundRobinKey(provider, now);
    if (selected !== null && sessionId !== undefined) {
      this.pinSessionKey(provider, sessionId, selected.index, now);
    }
    return selected;
  }

  public rotateSessionKey(
    provider: ProviderCode | string,
    sessionId: string,
    now: number = Date.now()
  ): SelectedKey | null {
    const keys = this.getKeys(provider);
    const total = keys.length;
    if (total === 0) {
      return null;
    }
    const pinId = this.makeSessionPinId(provider, sessionId);
    const previousPin = this.sessionPins.get(pinId);
    this.sessionPins.delete(pinId);
    const startIndex =
      previousPin !== undefined ? (previousPin.keyIndex + 1) % total : (this.pointers.get(provider) ?? 0);
    for (let offset = 0; offset < total; offset += 1) {
      const picked = this.tryPickIndex(provider, (startIndex + offset) % total, keys, now);
      if (picked !== null) {
        this.pinSessionKey(provider, sessionId, picked.index, now);
        return picked;
      }
    }
    return null;
  }

  private scheduleAvailabilityTimer(keyId: string, provider: string, ttlMs: number): void {
    const existing = this.activeTimers.get(keyId);
    if (existing) {
      clearTimeout(existing);
      this.activeTimers.delete(keyId);
    }
    if (ttlMs > 0) {
      const timer = setTimeout(() => {
        this.activeTimers.delete(keyId);
        this.emit(`available:${provider}`, provider);
        this.emit("available", provider);
      }, ttlMs);
      this.activeTimers.set(keyId, timer);
    }
  }

  public reportSuccess(provider: string, index: number): void {
    const keyId = this.makeKeyId(provider, index);
    this.cooldownManager.clearCooldown(keyId);
    const existing = this.activeTimers.get(keyId);
    if (existing) {
      clearTimeout(existing);
      this.activeTimers.delete(keyId);
    }
    this.emit(`available:${provider}`, provider);
    this.emit("available", provider);
  }

  public reportFailure(
    provider: string,
    index: number,
    status: number,
    headers?: Headers | Record<string, string>,
    body?: string,
    now: number = Date.now(),
    customTtlSec?: number
  ): KeyCooldownState {
    if (status === 401 || status === 403) {
      // Auth death is terminal for this key. Drop any session pin bound to it
      // BEFORE throwing, otherwise a pinned session stays glued to a
      // permanently-dead key for the full pin TTL (the throw below means the
      // normal invalidateSessionPins at the end of this method never runs).
      this.invalidateSessionPins(provider, index);
      throw new FatalAuthError(provider, index, status, body);
    }
    if (!this.isQuarantineEnabled(provider)) {
      return {
        quarantinedUntil: 0,
        reason: "quarantine_disabled",
        lastErrorStatus: status,
      };
    }
    const keyId = this.makeKeyId(provider, index);
    const state = this.cooldownManager.quarantineKey(keyId, status, headers, body, now, customTtlSec);
    this.invalidateSessionPins(provider, index);
    this.scheduleAvailabilityTimer(keyId, provider, state.quarantinedUntil - now);
    return state;
  }

  public quarantineKey(
    provider: string,
    index: number,
    ttlSec: number,
    reason?: string,
    status?: number,
    now: number = Date.now()
  ): KeyCooldownState {
    if (!this.isQuarantineEnabled(provider)) {
      return {
        quarantinedUntil: 0,
        reason: reason ?? "quarantine_disabled",
        lastErrorStatus: status,
      };
    }
    const keyId = this.makeKeyId(provider, index);
    const state = this.cooldownManager.quarantineKeyWithTtl(keyId, ttlSec, reason, status, now);
    this.invalidateSessionPins(provider, index);
    this.scheduleAvailabilityTimer(keyId, provider, state.quarantinedUntil - now);
    return state;
  }

  public conserveKey(
    provider: string,
    index: number,
    ttlSec: number,
    reason: string = "conserve_key",
    status?: number,
    now: number = Date.now()
  ): KeyCooldownState {
    const keyId = this.makeKeyId(provider, index);
    const state = this.cooldownManager.quarantineKeyWithTtl(keyId, ttlSec, reason, status, now);
    this.invalidateSessionPins(provider, index);
    this.scheduleAvailabilityTimer(keyId, provider, state.quarantinedUntil - now);
    return state;
  }

  public async waitForKeyAvailable(
    provider: ProviderCode | string,
    timeoutMs: number,
    signal?: AbortSignal,
    now: number = Date.now()
  ): Promise<SelectedKey | null> {
    const immediate = this.selectNextKey(provider, now);
    if (immediate !== null) {
      return immediate;
    }
    if (timeoutMs <= 0 || signal?.aborted) {
      return null;
    }
    return new Promise<SelectedKey | null>((resolve) => {
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      const eventName = `available:${provider}`;

      const cleanup = (): void => {
        if (timeoutTimer !== null) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        this.removeListener(eventName, onAvailable);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      };

      const onAvailable = (): void => {
        const selected = this.selectNextKey(provider);
        if (selected !== null) {
          cleanup();
          resolve(selected);
        }
      };

      const onAbort = (): void => {
        cleanup();
        resolve(null);
      };

      timeoutTimer = setTimeout(() => {
        cleanup();
        resolve(this.selectNextKey(provider));
      }, timeoutMs);

      this.on(eventName, onAvailable);
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  public getPoolSize(provider: string): number {
    return this.getKeys(provider).length;
  }

  public getStatus(provider: string, now: number = Date.now()): PoolStatus {
    const keys = this.getKeys(provider);
    const total = keys.length;
    if (!this.isQuarantineEnabled(provider)) {
      return { total, active: total, quarantined: 0 };
    }
    let quarantined = 0;
    for (let i = 0; i < total; i += 1) {
      const keyId = this.makeKeyId(provider, i);
      if (this.cooldownManager.isQuarantined(keyId, now)) {
        quarantined += 1;
      }
    }
    return { total, active: total - quarantined, quarantined };
  }

  public getMinQuarantineTtlMs(provider: string, now: number = Date.now()): number {
    if (!this.isQuarantineEnabled(provider)) {
      return 0;
    }
    return this.cooldownManager.getMinQuarantineTtlMs(provider, now);
  }

  public getDynamicMaxQueueDepth(provider: string): number {
    const status = this.getStatus(provider);
    return Math.max(10, status.active * 10);
  }

  public shouldLoadShed(
    provider: string,
    currentDwellMs: number,
    maxWaitMs: number = 20000,
    now: number = Date.now()
  ): boolean {
    const status = this.getStatus(provider, now);
    if (status.active > 0) return false;
    if (status.total === 0) return false;
    const minTtl = this.getMinQuarantineTtlMs(provider, now);
    const remainingWaitMs = Math.max(0, maxWaitMs - currentDwellMs);
    return minTtl > remainingWaitMs;
  }

  private resetProvider(provider: string): void {
    this.pointers.delete(provider);
    const prefix = `${provider}:`;
    for (const [pinId] of this.sessionPins) {
      if (pinId.startsWith(prefix)) {
        this.sessionPins.delete(pinId);
      }
    }
    for (const [keyId, timer] of this.activeTimers) {
      if (keyId === provider || keyId.startsWith(prefix)) {
        clearTimeout(timer);
        this.activeTimers.delete(keyId);
      }
    }
    const keys = this.getKeys(provider);
    for (let i = 0; i < keys.length; i += 1) {
      this.cooldownManager.clearCooldown(this.makeKeyId(provider, i));
    }
    this.emit(`available:${provider}`, provider);
    this.emit("available", provider);
  }

  public reset(provider?: string): void {
    if (provider) {
      this.resetProvider(provider);
      return;
    }
    this.pointers.clear();
    this.sessionPins.clear();
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this.cooldownManager.clearAll();
    this.emit("available");
  }
}