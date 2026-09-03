export const appSettings = {
  storageKeys: {
    theme: 'migration-studio-theme',
    session: 'migration-studio-session',
  },
  /** Must match server MAX_FILE_SIZE (50 MB). */
  maxUploadBytes: 50 * 1024 * 1024,
  pollIntervalMs: 2000,
  uploadTimeoutMs: 120_000, // 2 minutes
  downloadTimeoutMs: 300_000, // 5 minutes
  statusTimeoutMs: 30_000, // 30 seconds
  messageClearDelayMs: 4000,
  deleteTimeoutMs: 30_000, // 30 seconds
  projectCheckTimeoutMs: 15_000, // 15 seconds
};
