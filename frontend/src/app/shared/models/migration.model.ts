export type ThemeMode = 'light' | 'dark';

export type ModelOption = {
  id: string;
  label: string;
};

export type VersionOption = {
  major: number;
  label: string;
  version: string;
};

export type MigrateStartResponse = {
  sessionId: string;
  status: string;
  message?: string;
  statusUrl?: string;
  downloadUrl?: string;
};

export type MigrateStatusResponse = {
  sessionId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | string;
  message?: string;
  phase?: string | null;
  unitIndex?: number | null;
  unitTotal?: number | null;
  error?: string;
  downloadUrl?: string;
  elapsedMs?: number;
};

export type ProjectSession = {
  sessionId: string;
  projectName?: string;
  fromTech?: string;
  toTech?: string;
  aiProvider?: string;
  aiModel?: string;
  updatedAt?: number;
};

export type ProjectCheckResponse = {
  exists: boolean;
  sessionId?: string;
  projectName?: string;
  fromTech?: string;
  toTech?: string;
  aiProvider?: string;
  aiModel?: string;
  updatedAt?: number;
};

export type TechnologyOption = {
  id: number;
  technology: string;
};

export type AiProviderOption = {
  id: string;
  label: string;
};
