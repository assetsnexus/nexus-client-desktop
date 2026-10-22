/**
 * Electron `safeStorage`-backed secure store.
 *
 * Values are encrypted with the OS keychain (macOS Keychain, Windows DPAPI,
 * Linux libsecret). When `safeStorage` is unavailable (some Linux setups) we
 * degrade to plaintext on disk and report `encrypted: false` so the UI can warn.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';
import type { SecureStore } from '@nexus/node-core';

type PersistedShape = {
  encrypted: boolean;
  values: Record<string, string>;
};

export class SafeStorageStore implements SecureStore {
  private readonly filePath: string;
  private cache: PersistedShape | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(app.getPath('userData'), 'secure-store.json');
  }

  /** Whether values are actually encrypted at rest. */
  get encrypted(): boolean {
    return this.cache?.encrypted ?? this.canEncrypt();
  }

  private canEncrypt(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private read(): PersistedShape {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = { encrypted: this.canEncrypt(), values: {} };
      return this.cache;
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedShape;
      this.cache = {
        encrypted: Boolean(raw.encrypted),
        values: raw.values && typeof raw.values === 'object' ? raw.values : {},
      };
    } catch {
      this.cache = { encrypted: this.canEncrypt(), values: {} };
    }
    return this.cache;
  }

  private write(): void {
    const data = this.read();
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  }

  async get(key: string): Promise<string | null> {
    const data = this.read();
    const stored = data.values[key];
    if (stored == null) return null;
    if (!data.encrypted) return stored;
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const data = this.read();
    if (data.encrypted) {
      data.values[key] = safeStorage.encryptString(value).toString('base64');
    } else {
      data.values[key] = value;
    }
    this.write();
  }

  async delete(key: string): Promise<void> {
    const data = this.read();
    delete data.values[key];
    this.write();
  }

  /**
   * Remove every stored secret (permanent logout). Keeps the file but empties
   * the value map so no token, device key or PIN survives.
   */
  async clear(): Promise<void> {
    const data = this.read();
    data.values = {};
    this.write();
  }
}
