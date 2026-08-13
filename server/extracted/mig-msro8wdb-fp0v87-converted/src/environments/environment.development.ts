export const environment = {
  production: false,
  host: '',
  clientId: '',
  clientSecret: '',
  encryption: {
    encryptedRequest: false,
    CRYPTO_JS_KEY: '',
    CRYPTO_JS_IV: '',
    CRYPTO_ALGORITHM: 'AES-CBC',
    CRYPTO_KEY_HEX: '', // 32 bytes (64 hex chars)
    CRYPTO_IV_HEX: '', // 16 bytes (32 hex chars)
  },
};
