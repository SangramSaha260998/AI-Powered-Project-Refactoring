export const appSettings = {
  storageKeys: {
    theme: 'migration-studio-theme',
    session: 'migration-studio-session',
  },
  /** Must match server MAX_FILE_SIZE (50 MB). */
  maxUploadBytes: 50 * 1024 * 1024,
  pollIntervalMs: 2000,
  /** Upload + cold-start on Render can exceed 2 minutes. */
  uploadTimeoutMs: 300_000,
  downloadTimeoutMs: 300_000,
  /** Status poll must survive Render free-tier wake-up. */
  statusTimeoutMs: 120_000,
  messageClearDelayMs: 4000,
  deleteTimeoutMs: 60_000,
  projectCheckTimeoutMs: 90_000,
  /** Wake sleeping Render instance before first migration request. */
  backendWarmupRetries: 4,
  backendWarmupDelayMs: 8000,
};
