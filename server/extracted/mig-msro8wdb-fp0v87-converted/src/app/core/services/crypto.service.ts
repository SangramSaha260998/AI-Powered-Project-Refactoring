import { Injectable } from '@angular/core';
import { environment } from '@env/environment';

@Injectable({
  providedIn: 'root',
})
export class CryptoService {
  /**
   * Converts a hex string to Uint8Array
   */
  private hexToUint8Array(hex: string) {
    return new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
  }

  /**
   * Converts Base64 string to Uint8Array
   */
  private base64ToUint8Array(base64: string) {
    return new Uint8Array([...atob(base64)].map((char) => char.charCodeAt(0)));
  }

  /**
   * Converts Uint8Array to Base64 string
   */
  private uint8ArrayToBase64(buffer: Uint8Array) {
    return btoa(String.fromCharCode(...buffer));
  }

  /**
   * Imports the AES key
   */
  private async importKey(): Promise<CryptoKey> {
    const keyBytes = this.hexToUint8Array(environment.encryption.CRYPTO_KEY_HEX);
    return crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: environment.encryption.CRYPTO_ALGORITHM, length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /**
   * Encrypts text using AES-256-CBC
   */
  async encrypt(data: Record<string, any> | any): Promise<string> {
    try {
      if (!data) return '';

      const key = await this.importKey();
      const iv = this.hexToUint8Array(environment.encryption.CRYPTO_IV_HEX);
      const encoder = new TextEncoder();
      const encryptedData = await crypto.subtle.encrypt(
        { name: environment.encryption.CRYPTO_ALGORITHM, iv },
        key,
        encoder.encode(JSON.stringify(data)),
      );

      return this.uint8ArrayToBase64(new Uint8Array(encryptedData));
    } catch (error) {
      console.error(error);
      return '';
    }
  }

  /**
   * Decrypts AES-256-CBC encrypted text
   */
  async decrypt(encryptedText: string): Promise<any> {
    try {
      if (!encryptedText) return '';

      const key = await this.importKey();
      const iv = this.hexToUint8Array(environment.encryption.CRYPTO_IV_HEX);
      const encryptedData = this.base64ToUint8Array(encryptedText);

      const decryptedData = await crypto.subtle.decrypt(
        { name: environment.encryption.CRYPTO_ALGORITHM, iv },
        key,
        encryptedData,
      );

      return JSON.parse(new TextDecoder().decode(decryptedData));
    } catch (error) {
      console.error(error);
      return { error: 'Decryption failed' };
    }
  }
}
