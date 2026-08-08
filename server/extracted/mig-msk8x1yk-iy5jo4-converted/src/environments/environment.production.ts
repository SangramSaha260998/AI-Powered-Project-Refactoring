export const environment: {
  production: boolean;
  host: string;
  apiUrl: string;
  appTitle: string;
  theme: string;
  encryption: { encryptedRequest: boolean };
  [key: string]: unknown;
} = {
  production: true,
  host: '',
  apiUrl: '/api',
  appTitle: 'Migrated Application',
  theme: 'light',
  encryption: {
    encryptedRequest: false
  }
};
