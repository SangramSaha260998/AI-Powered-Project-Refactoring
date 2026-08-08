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
  host: 'https://uat-api.example.com',
  apiUrl: 'https://uat-api.example.com/api',
  appTitle: 'Migrated Application',
  theme: 'light',
  encryption: {
    encryptedRequest: false
  }
};
