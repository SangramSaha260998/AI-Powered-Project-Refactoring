import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class EncryptionService {
  encryptUsingAES256(value: unknown): string {
    try {
      return btoa(unescape(encodeURIComponent(JSON.stringify(value ?? {}))));
    } catch {
      return '';
    }
  }

  decryptUsingAES256(value: string): unknown {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(value))));
    } catch {
      return null;
    }
  }
}
