export const environment: {
  production: boolean;
  host: string;
  apiUrl: string;
  appTitle: string;
  theme: string;
  encryption: { encryptedRequest: boolean };
  [key: string]: unknown;
} = {
  production: false,
  host: 'http://localhost:3000',
  apiUrl: 'http://localhost:3000/api',
  appTitle: 'Migrated Application',
  theme: 'light',
  encryption: {
    encryptedRequest: false
  }
};
