import { Injectable } from '@angular/core';

/** Stub crypto used by angular_required HTTP success interceptor. */
@Injectable({ providedIn: 'root' })
export class CryptoService {
  async encrypt(data: Record<string, unknown>): Promise<string> {
    try {
      return btoa(unescape(encodeURIComponent(JSON.stringify(data ?? {}))));
    } catch {
      return '';
    }
  }

  async decrypt(payload: string): Promise<unknown> {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(payload))));
    } catch {
      return null;
    }
  }
}
