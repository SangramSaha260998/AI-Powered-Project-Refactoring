import * as CryptoJS from 'crypto-js';
import { Injectable } from '@angular/core';
import { environment } from '@env/environment';

@Injectable({ providedIn: 'root' })
export class EncryptionService {
  // string key length must me 16 character (HEX Char)
  private key = CryptoJS.enc.Utf8.parse(environment.encryption.CRYPTO_JS_KEY);
  private iv = CryptoJS.enc.Utf8.parse(environment.encryption.CRYPTO_JS_IV);

  /**
   * * Encrypt Using AES256
   *
   * @param request
   * @returns response
   * @developer Abhisek Dhua
   */
  encryptUsingAES256(request: Record<string, any> | any) {
    let response = '';
    try {
      response = CryptoJS.AES.encrypt(JSON.stringify(request), this.key, {
        iv: this.iv,
        mode: CryptoJS.mode.ECB,
        padding: CryptoJS.pad.Pkcs7,
      }).toString();
    } catch (error) {
      console.error(error);
      response = '';
    }
    return response;
  }

  /**
   * * Decrypt Using AES256
   * JSON Parse date before use
   * @param request
   * @returns response
   * @developer Abhisek Dhua
   */
  decryptUsingAES256(request: string) {
    let response = '';
    try {
      response = CryptoJS.AES.decrypt(request, this.key, {
        iv: this.iv,
        mode: CryptoJS.mode.ECB,
        padding: CryptoJS.pad.Pkcs7,
      }).toString(CryptoJS.enc.Utf8);
    } catch (error) {
      console.error(error);
      response = '';
    }
    return JSON.parse(response ? response : JSON.stringify({ error: true }));
  }
}
