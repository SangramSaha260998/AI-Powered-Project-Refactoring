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
  host: 'https://staging-api.example.com',
  apiUrl: 'https://staging-api.example.com/api',
  appTitle: 'Migrated Application',
  theme: 'light',
  encryption: {
    encryptedRequest: false
  }
};
