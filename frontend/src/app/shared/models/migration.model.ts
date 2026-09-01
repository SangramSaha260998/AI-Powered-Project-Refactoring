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
  status: 'queued' | 'running' | 'completed' | 'failed' | 'paused' | string;
  message?: string;
  phase?: string | null;
  unitIndex?: number | null;
  unitTotal?: number | null;
  completedUnitIndex?: number | null;
  error?: string;
  downloadUrl?: string;
  elapsedMs?: number;
  resumable?: boolean;
};

export type ProjectSession = {
  sessionId: string;
  projectName?: string;
  fromTech?: string;
  toTech?: string;
  aiProvider?: string;
  aiModel?: string;
  updatedAt?: number;
  resumable?: boolean;
  paused?: boolean;
  completedUnitIndex?: number;
  unitTotal?: number;
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
  resumable?: boolean;
  paused?: boolean;
  completedUnitIndex?: number;
  unitTotal?: number;
};

export type TechnologyOption = {
  id: number;
  technology: string;
};

export type AiProviderOption = {
  id: string;
  label: string;
};

export type AnalysisComponent = {
  name: string;
  file: string;
};

export type AnalysisService = {
  name: string;
  file: string;
};

export type AnalysisRoute = {
  path: string;
  file: string;
};

export type AnalysisHook = {
  name: string;
  file: string;
};

export type AnalysisContext = {
  name: string;
  file: string;
};

export type SourceAnalysis = {
  framework: string;
  fileCount: number;
  fileTree: string[];
  components: AnalysisComponent[];
  services: AnalysisService[];
  routes: AnalysisRoute[];
  hooks: AnalysisHook[];
  contexts: AnalysisContext[];
};

export type ReferenceAnalysis = {
  framework: string;
  fileCount: number;
  folders: string[];
  sharedComponents: AnalysisComponent[];
  services: AnalysisService[];
  guards: Array<{ name: string; file: string }>;
  interceptors: Array<{ name: string; file: string }>;
  styling: {
    tailwind: boolean;
    scss: boolean;
    material: boolean;
    ngxs: boolean;
  };
};

export type MigrationMapping = {
  source: string;
  sourceName: string;
  target: string;
  type: string;
};

export type PlanUnit = {
  newPath: string;
  complexity: string;
  unit: string;
};

export type MigrationPlanPreview = {
  fromTech: string;
  toTech: string;
  mappings: MigrationMapping[];
  plan: PlanUnit[];
  referenceArchitecture: ReferenceAnalysis | null;
};

export type AnalyzeResponse = {
  sessionId: string;
  fromTech: string;
  toTech: string;
  sourceAnalysis: SourceAnalysis;
  referenceAnalysis: ReferenceAnalysis | null;
  migrationPlan: MigrationPlanPreview;
};

export type VisualQaComparison = {
  route: string;
  sourceImage: string;
  migratedImage: string;
  diffImage: string | null;
  similarity: number;
  diffPixels: number;
  totalPixels: number;
  passed: boolean;
  error?: string;
};

export type VisualQaReport = {
  generatedAt: number;
  sourceTech: string;
  migratedTech: string;
  routes: string[];
  comparisons: VisualQaComparison[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    averageSimilarity: number;
  };
  reportPath?: string;
};
