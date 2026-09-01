import { Component, ElementRef, OnDestroy, inject, signal, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { ThemeService, SessionService } from '@core/services';
import { MigrationService } from '@core/http';

import {
  ModelOption,
  VersionOption,
  TechnologyOption,
  AiProviderOption,
  MigrateStatusResponse,
  ProjectSession,
  ProjectCheckResponse,
} from '@shared/models';
import { appSettings } from '@app/config';
import { isWithinUploadLimit, isZipFileName, triggerBlobDownload } from '@shared/utilities';

@Component({
  selector: 'app-create-migration',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './create.component.html',
  styleUrl: './create.component.scss',
})
export class CreateMigrationComponent implements OnDestroy {
  private readonly migrationService = inject(MigrationService);
  private readonly sessionService = inject(SessionService);
  private readonly route = inject(ActivatedRoute);
  readonly themeService = inject(ThemeService);

  private static readonly RETIRED_GENAI = /gemini-(1\.5|2\.0|2\.5)-/;
  private static readonly PREFERRED_GENAI = [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
  ];

  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  technologies: TechnologyOption[] = [
    { id: 1, technology: 'Angular' },
    { id: 2, technology: 'React' },
  ];

  frameworkVersions: Record<string, VersionOption[]> = {
    Angular: [
      { major: 22, label: 'Angular 22 (Latest)', version: '22' },
      { major: 21, label: 'Angular 21', version: '21' },
      { major: 20, label: 'Angular 20', version: '20' },
      { major: 19, label: 'Angular 19', version: '19' },
      { major: 18, label: 'Angular 18', version: '18' },
    ],
    React: [
      { major: 19, label: 'React 19 (Latest)', version: '19' },
      { major: 18, label: 'React 18', version: '18' },
      { major: 17, label: 'React 17', version: '17' },
    ],
  };

  aiProviders: AiProviderOption[] = [
    { id: 'genai', label: 'Google Gemini' },
    { id: 'openrouter', label: 'OpenRouter' },
    { id: 'groq', label: 'Groq' },
    { id: 'ollama', label: 'Ollama Cloud' },
    { id: 'tokenrouter', label: 'TokenRouter' },
  ];

  providerModels: Record<string, ModelOption[]> = {
    openrouter: [],
    genai: [],
    groq: [],
    ollama: [],
    tokenrouter: [],
  };

  fromTech = signal<string>('');
  toTech = signal<string>('');
  aiProvider = signal<string>('genai');
  aiModel = signal<string>('');
  targetVersion = signal<string>('');
  isDragging = signal<boolean>(false);
  selectedFile = signal<File | null>(null);
  prompt = signal<string>('');
  isLoading = signal<boolean>(false);
  statusMessage = signal<string>('');
  isSuccess = signal<boolean>(false);
  modelsLoading = signal<boolean>(false);
  progressText = signal<string>('Running AI migration pipeline...');
  migrationProgress = signal<number>(-1);
  currentStep = signal<string>('');
  totalSteps = signal<number>(0);
  currentStepIndex = signal<number>(0);
  readySessionId = signal<string | null>(null);
  activeProject = signal<ProjectSession | null>(null);
  checkingProject = signal<boolean>(true);
  reworkPrompt = signal<string>('');

  private modelsVersion = signal(0);
  private lastSessionId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startSub: Subscription | null = null;
  private settlingDownload = false;
  private lastMode: 'create' | 'rework' = 'create';

  private readonly defaultStripDownPrompt = `Convert the uploaded project completely.

Keep every page, component, route, and service from the source.
Preserve branding, layout, and behavior unless I specify otherwise.
Output must compile and run after npm install.`;

  get placeholderText(): string {
    const from = this.fromTech();
    const to = this.toTech();
    if (!from && !to) {
      return 'e.g., Convert Angular components to React functional components with hooks...';
    }
    if (from && !to) {
      return `e.g., Convert ${from} components to your target framework...`;
    }
    if (!from && to) {
      return `e.g., Convert your source framework components to ${to}...`;
    }
    return `e.g., Convert ${from} components to ${to} functional components with hooks, ensuring all lifecycle methods are replaced appropriately...`;
  }

  get currentVersions(): VersionOption[] {
    return this.frameworkVersions[this.toTech()] || [];
  }

  get currentModels(): ModelOption[] {
    this.modelsVersion();
    return this.providerModels[this.aiProvider()] || [];
  }

  constructor() {
    this.loadProviderModels('genai');
    void this.checkExistingProject();
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.startSub?.unsubscribe();
  }

  onFromChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.fromTech.set(value);
    this.autoFillPromptIfSameFramework();
  }

  onToChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.toTech.set(value);
    this.targetVersion.set('');
    this.autoFillPromptIfSameFramework();
  }

  onVersionChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.targetVersion.set(value);
  }

  onProviderChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.aiProvider.set(value);
    this.aiModel.set('');
    if (
      this.isDynamicProvider(value) &&
      this.providerModels[value].length === 0 &&
      !this.modelsLoading()
    ) {
      this.loadProviderModels(value);
    }
  }

  onModelChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.aiModel.set(value);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(true);
  }

  onDragLeave(): void {
    this.isDragging.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(false);
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.validateAndSetFile(files[0]);
    }
  }

  onPromptChange(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.prompt.set(value);
  }

  onReworkPromptChange(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.reworkPrompt.set(value);
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.validateAndSetFile(input.files[0]);
    }
  }

  submitChanges(): void {
    const project = this.activeProject();
    if (!project?.sessionId || this.isLoading()) return;

    const promptText = this.reworkPrompt().trim();
    if (!promptText) {
      this.isSuccess.set(false);
      this.statusMessage.set('❌ Please enter a change or error description.');
      this.clearMessage();
      return;
    }

    this.stopPolling();
    this.startSub?.unsubscribe();
    this.settlingDownload = false;

    this.isLoading.set(true);
    this.isSuccess.set(false);
    this.readySessionId.set(null);
    this.progressText.set('Submitting changes...');
    this.statusMessage.set('⏳ Submitting changes to AI...');
    this.migrationProgress.set(-1);
    this.currentStep.set('Processing...');
    this.totalSteps.set(0);
    this.currentStepIndex.set(0);

    this.lastSessionId = project.sessionId;
    this.lastMode = 'rework';

    this.startSub = this.migrationService
      .submitChanges(
        project.sessionId,
        promptText,
        this.activeProject()?.aiProvider,
        this.activeProject()?.aiModel,
      )
      .subscribe({
        next: (res) => {
          const sessionId = res.sessionId || project.sessionId;
          this.lastSessionId = sessionId;
          this.progressText.set(res.message || 'Applying changes...');
          this.statusMessage.set(`⏳ ${res.message || 'Applying changes...'}`);
          this.startStatusPolling(sessionId, 'rework');
        },
        error: (err: any) => {
          this.stopPolling();
          this.isLoading.set(false);
          this.isSuccess.set(false);
          this.lastSessionId = null;
          let errorMessage = 'Failed to submit changes.';
          if (err?.error?.error) {
            errorMessage = err.error.error;
          } else if (err?.message) {
            errorMessage = err.message;
          }
          this.statusMessage.set(`❌ ${errorMessage}`);
          console.error(err);
        },
      });
  }

  uploadProject(): void {
    const file = this.selectedFile();
    if (!file) return;

    const from = this.fromTech();
    const to = this.toTech();
    const promptText = this.prompt().trim();

    if (!from || !to) {
      this.isSuccess.set(false);
      this.statusMessage.set('❌ Please select both source and target frameworks.');
      this.clearMessage();
      return;
    }
    if (!this.aiProvider()) {
      this.isSuccess.set(false);
      this.statusMessage.set('❌ Please select an AI provider.');
      this.clearMessage();
      return;
    }
    if (!this.aiModel()) {
      this.isSuccess.set(false);
      this.statusMessage.set('❌ Please select a model.');
      this.clearMessage();
      return;
    }
    if (!promptText) {
      this.isSuccess.set(false);
      this.statusMessage.set('❌ Please enter a migration prompt.');
      this.clearMessage();
      return;
    }

    this.stopPolling();
    this.startSub?.unsubscribe();
    this.settlingDownload = false;

    this.isLoading.set(true);
    this.isSuccess.set(false);
    this.readySessionId.set(null);
    this.progressText.set('Uploading project and starting migration...');
    this.statusMessage.set('⏳ Uploading project and starting migration...');
    this.migrationProgress.set(-1);
    this.currentStep.set('Uploading files...');
    this.totalSteps.set(0);
    this.currentStepIndex.set(0);

    this.lastSessionId =
      'mig-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

    const formData = new FormData();
    formData.append('zipFile', file);
    formData.append('sessionId', this.lastSessionId);
    formData.append('fromTech', from);
    formData.append('toTech', to);
    formData.append('prompt', promptText);
    formData.append('aiProvider', this.aiProvider());
    if (this.aiModel()) {
      formData.append('aiModel', this.aiModel());
    }
    if (this.targetVersion()) {
      formData.append('targetVersion', this.targetVersion());
    }

    this.lastMode = 'create';

    this.startSub = this.migrationService.startMigration(formData).subscribe({
      next: (res) => {
        const sessionId = res.sessionId || this.lastSessionId!;
        this.lastSessionId = sessionId;
        this.progressText.set(res.message || 'Migration started...');
        this.statusMessage.set(`⏳ ${res.message || 'Migration started...'}`);
        this.startStatusPolling(sessionId, 'create');
      },
      error: async (err: any) => {
        this.stopPolling();
        this.isLoading.set(false);
        this.isSuccess.set(false);
        this.lastSessionId = null;
        let errorMessage = 'Unknown server error';
        if (err?.error?.error) {
          errorMessage = err.error.error;
        } else if (err?.message) {
          errorMessage = err.message;
        }
        this.statusMessage.set(`❌ ${errorMessage}`);
        console.error(err);
      },
    });
  }

  downloadReadySession(): void {
    const sessionId = this.readySessionId();
    if (!sessionId) return;
    this.isLoading.set(true);
    void this.downloadCompletedSession(sessionId, this.lastMode);
  }

  dismissReadyDownload(): void {
    this.readySessionId.set(null);
    this.lastSessionId = null;
    this.statusMessage.set('');
  }

  clearProject(): void {
    const project = this.activeProject();
    if (!project?.sessionId || this.isLoading()) return;

    this.isLoading.set(true);
    this.isSuccess.set(false);
    this.statusMessage.set('⏳ Clearing extracted project...');

    this.migrationService.deleteProject(project.sessionId).subscribe({
      next: () => {
        this.sessionService.clearSession();
        this.activeProject.set(null);
        this.reworkPrompt.set('');
        this.isLoading.set(false);
        this.isSuccess.set(true);
        this.statusMessage.set('✅ Extracted project folder cleared.');
        this.clearMessage();
      },
      error: async (err: any) => {
        this.isLoading.set(false);
        this.isSuccess.set(false);
        let errorMessage = 'Failed to clear the project.';
        if (err?.error instanceof Blob) {
          try {
            const text = await err.error.text();
            errorMessage = JSON.parse(text).error || errorMessage;
          } catch {
            errorMessage = err?.message || errorMessage;
          }
        } else {
          errorMessage = err?.error?.error || err?.message || errorMessage;
        }
        this.statusMessage.set(`❌ ${errorMessage}`);
        this.clearMessage();
      },
    });
  }

  continueConversion(): void {
    const project = this.activeProject();
    if (!project?.sessionId || this.isLoading()) return;

    this.stopPolling();
    this.startSub?.unsubscribe();
    this.settlingDownload = false;

    this.isLoading.set(true);
    this.isSuccess.set(false);
    this.readySessionId.set(null);
    this.progressText.set('Resuming conversion...');
    this.statusMessage.set('⏳ Resuming conversion from the last saved unit...');
    this.migrationProgress.set(-1);
    this.currentStep.set('Resuming...');
    this.totalSteps.set(project.unitTotal || 0);
    this.currentStepIndex.set(Math.max(0, (project.completedUnitIndex ?? -1) + 1));

    this.lastSessionId = project.sessionId;
    this.lastMode = 'create';

    this.startSub = this.migrationService
      .resumeMigration(project.sessionId, project.aiProvider, project.aiModel)
      .subscribe({
        next: (res) => {
          const sessionId = res.sessionId || project.sessionId;
          this.lastSessionId = sessionId;
          this.progressText.set(res.message || 'Resuming conversion...');
          this.statusMessage.set(`⏳ ${res.message || 'Resuming conversion...'}`);
          this.startStatusPolling(sessionId, 'create');
        },
        error: (err: any) => {
          this.stopPolling();
          this.isLoading.set(false);
          this.isSuccess.set(false);
          let errorMessage = 'Failed to resume conversion.';
          if (err?.error?.error) {
            errorMessage = err.error.error;
          } else if (err?.message) {
            errorMessage = err.message;
          }
          this.statusMessage.set(`❌ ${errorMessage}`);
          console.error(err);
        },
      });
  }

  downloadLatestZip(): void {
    const project = this.activeProject();
    if (!project?.sessionId || this.isLoading()) return;

    this.isLoading.set(true);
    this.isSuccess.set(false);
    this.readySessionId.set(null);
    this.progressText.set('Preparing your project ZIP...');
    this.statusMessage.set('⏳ Preparing your project ZIP...');

    firstValueFrom(this.migrationService.downloadProject(project.sessionId))
      .then((blob) => {
        triggerBlobDownload(blob);
        this.isLoading.set(false);
        this.isSuccess.set(true);
        this.progressText.set('Running AI migration pipeline...');
        this.statusMessage.set('✅ Latest project ZIP downloaded.');
        this.clearMessage();
      })
      .catch(async (err: any) => {
        this.isLoading.set(false);
        this.isSuccess.set(false);
        let errorMessage = 'Download failed. Please try again.';
        if (err?.error instanceof Blob) {
          try {
            const text = await err.error.text();
            errorMessage = JSON.parse(text).error || errorMessage;
          } catch {
            errorMessage = err?.message || errorMessage;
          }
        } else {
          errorMessage = err?.error?.error || err?.message || errorMessage;
        }
        this.statusMessage.set(`⚠️ ${errorMessage}`);
      });
  }

  clearMessage(): void {
    if (this.isLoading() || this.readySessionId()) return;
    setTimeout(() => {
      if (!this.isLoading() && !this.readySessionId()) {
        this.statusMessage.set('');
      }
    }, appSettings.messageClearDelayMs);
  }

  providerLabel(id: string | undefined): string {
    const found = this.aiProviders.find((p) => p.id === id);
    return found ? found.label : id || '—';
  }

  private isDynamicProvider(provider: string): boolean {
    return (
      provider === 'openrouter' ||
      provider === 'genai' ||
      provider === 'groq' ||
      provider === 'ollama' ||
      provider === 'tokenrouter'
    );
  }

  private loadProviderModels(provider: string): void {
    if (!this.isDynamicProvider(provider)) return;
    this.modelsLoading.set(true);
    this.migrationService.loadModels(provider).subscribe({
      next: (res) => {
        this.providerModels[provider] = this.filterProviderModels(provider, res.models ?? []);
        this.modelsVersion.update((v) => v + 1);
        this.modelsLoading.set(false);
        if (this.aiProvider() === provider) {
          const current = this.aiModel();
          const models = this.providerModels[provider];
          if (!current && models.length > 0) {
            this.aiModel.set(models[0].id);
          } else if (current && !models.some((m) => m.id === current)) {
            this.aiModel.set(models[0]?.id || '');
          }
        }
      },
      error: (err) => {
        console.error(`Failed to load ${provider} models:`, err);
        this.providerModels[provider] = [];
        this.modelsVersion.update((v) => v + 1);
        this.modelsLoading.set(false);
        const msg = err?.error?.error || err?.message || `Failed to load ${provider} models.`;
        this.isSuccess.set(false);
        this.statusMessage.set(`❌ ${msg}`);
        this.clearMessage();
      },
    });
  }

  private autoFillPromptIfSameFramework(): void {
    const from = this.fromTech();
    const to = this.toTech();
    if (!from || !to) return;
    if (!this.prompt() || this.prompt() === this.defaultStripDownPrompt) {
      this.prompt.set(this.defaultStripDownPrompt);
    }
  }

  private filterProviderModels(provider: string, models: ModelOption[]): ModelOption[] {
    let list = models.filter((m) => Boolean(m?.id));
    if (provider === 'genai') {
      list = list.filter((m) => !CreateMigrationComponent.RETIRED_GENAI.test(m.id));
      list = [...list].sort((a, b) => {
        const preferred = CreateMigrationComponent.PREFERRED_GENAI;
        const ai = preferred.indexOf(a.id);
        const bi = preferred.indexOf(b.id);
        if (ai !== -1 || bi !== -1) {
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        }
        return a.label.localeCompare(b.label);
      });
    }
    return list;
  }

  private applyQueryParams(): void {
    const q = this.route.snapshot.queryParamMap;
    const fromRaw = (q.get('fromTech') || '').trim();
    const toRaw = (q.get('toTech') || '').trim();
    const matchTech = (value: string) =>
      this.technologies.find((t) => t.technology.toLowerCase() === value.toLowerCase())
        ?.technology;
    const from = fromRaw ? matchTech(fromRaw) : '';
    const to = toRaw ? matchTech(toRaw) : '';
    if (from) this.fromTech.set(from);
    if (to) this.toTech.set(to);
    if (from && to) this.autoFillPromptIfSameFramework();
  }

  private validateAndSetFile(file: File): void {
    if (!isZipFileName(file.name)) {
      this.isSuccess.set(false);
      this.statusMessage.set('❌ Invalid file format. Please drop a valid zipped archive.');
      this.selectedFile.set(null);
      this.clearMessage();
      return;
    }
    if (!isWithinUploadLimit(file.size, appSettings.maxUploadBytes)) {
      this.isSuccess.set(false);
      this.statusMessage.set('❌ ZIP exceeds the 50 MB size limit. Remove node_modules and retry.');
      this.selectedFile.set(null);
      this.clearMessage();
      return;
    }
    this.selectedFile.set(file);
    this.statusMessage.set('');
    this.isSuccess.set(false);
    this.readySessionId.set(null);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private applyProgress(status: MigrateStatusResponse): void {
    const base = status.message || 'Migrating...';
    let progress = -1;
    if (status.unitIndex && status.unitTotal && status.unitTotal > 0) {
      progress = Math.round((status.unitIndex / status.unitTotal) * 100);
      this.migrationProgress.set(progress);
      this.currentStepIndex.set(status.unitIndex);
      this.totalSteps.set(status.unitTotal);
    } else {
      this.migrationProgress.set(-1);
    }
    if (status.phase) {
      this.currentStep.set(this.getPhaseDescription(status.phase));
    }
    const progressBit = progress >= 0 ? ` [${progress}%]` : '';
    const unitBit =
      status.unitIndex && status.unitTotal ? ` (${status.unitIndex}/${status.unitTotal})` : '';
    const text = `${base}${unitBit}${progressBit}`;
    this.progressText.set(text);
    this.statusMessage.set(`⏳ ${text}`);
  }

  private getPhaseDescription(phase: string): string {
    const phaseDescriptions: Record<string, string> = {
      queued: 'Queued...',
      starting: 'Starting migration...',
      extract: 'Extracting project files...',
      extracting: 'Extracting project files...',
      reading: 'Reading source code...',
      analyze: 'Analyzing project structure...',
      blueprint: 'Creating migration plan...',
      planning: 'Creating migration plan...',
      unit: 'Converting components...',
      converting: 'Converting components...',
      generating: 'Generating Angular code...',
      building: 'Building project...',
      fixing: 'Fixing build errors...',
      resume: 'Resuming conversion...',
      rework: 'Applying changes...',
      'visual-qa': 'Running visual QA comparison...',
      package: 'Packaging project...',
      packaging: 'Packaging project...',
      completed: 'Migration complete!',
      failed: 'Migration failed',
    };
    return phaseDescriptions[phase] || `${phase}...`;
  }

  private async downloadCompletedSession(
    sessionId: string,
    mode: 'create' | 'rework' = 'create',
  ): Promise<void> {
    this.progressText.set(
      mode === 'rework' ? 'Downloading updated project...' : 'Downloading migrated project...',
    );
    this.statusMessage.set(
      `⏳ ${mode === 'rework' ? 'Downloading updated project...' : 'Downloading migrated project...'}`,
    );

    try {
      const blob = await firstValueFrom(this.migrationService.downloadProject(sessionId));
      triggerBlobDownload(blob);
      this.lastSessionId = null;
      if (mode === 'rework') {
        this.isLoading.set(false);
        this.isSuccess.set(true);
        this.readySessionId.set(null);
        this.progressText.set('Running AI migration pipeline...');
        this.reworkPrompt.set('');
        this.statusMessage.set('✅ Changes applied! Updated ZIP downloaded successfully.');
        void this.refreshProjectMeta(sessionId);
        this.clearMessage();
      } else {
        this.clearUiAfterSuccess(sessionId);
      }
    } catch (err: any) {
      this.isLoading.set(false);
      this.isSuccess.set(false);
      this.readySessionId.set(sessionId);
      let errorMessage = 'Migration finished, but download failed. You can try again.';
      if (err?.error instanceof Blob) {
        try {
          const text = await err.error.text();
          const parsed = JSON.parse(text);
          errorMessage = parsed.error || errorMessage;
        } catch {
          errorMessage = err?.message || errorMessage;
        }
      } else {
        errorMessage = err?.error?.error || err?.message || errorMessage;
      }
      this.statusMessage.set(`⚠️ ${errorMessage}`);
    }
  }

  private clearUiAfterSuccess(sessionId?: string): void {
    const from = this.fromTech();
    const to = this.toTech();
    const provider = this.aiProvider();
    const model = this.aiModel();
    const fileName = this.selectedFile()?.name;

    this.fromTech.set('');
    this.toTech.set('');
    this.targetVersion.set('');
    this.aiProvider.set('genai');
    this.aiModel.set('');
    this.prompt.set('');
    this.selectedFile.set(null);
    this.isDragging.set(false);
    this.isLoading.set(false);
    this.isSuccess.set(true);
    this.readySessionId.set(null);
    this.progressText.set('Running AI migration pipeline...');
    this.migrationProgress.set(100);
    this.currentStep.set('Complete!');
    this.totalSteps.set(0);
    this.currentStepIndex.set(0);
    this.statusMessage.set(
      '🎉 Project created! ZIP downloaded. You can now submit changes or errors below.',
    );

    const input = this.fileInput()?.nativeElement;
    if (input) {
      input.value = '';
    }

    if (sessionId) {
      const session: ProjectSession = {
        sessionId,
        projectName: fileName?.replace(/\.zip$/i, '') || 'Migrated Project',
        fromTech: from,
        toTech: to,
        aiProvider: provider,
        aiModel: model,
      };
      this.activeProject.set(session);
      this.sessionService.writeSession(session);
      void this.refreshProjectMeta(sessionId);
    }

    this.clearMessage();
    if (this.providerModels['genai'].length === 0) {
      this.loadProviderModels('genai');
    } else if (!this.aiModel() && this.providerModels['genai'].length > 0) {
      this.aiModel.set(this.providerModels['genai'][0].id);
    }
  }

  private startStatusPolling(sessionId: string, mode: 'create' | 'rework' = 'create'): void {
    this.stopPolling();

    const tick = async () => {
      try {
        const status = await firstValueFrom(this.migrationService.pollStatus(sessionId));

        if (status.status === 'queued' || status.status === 'running') {
          this.applyProgress(status);
          return;
        }

        this.stopPolling();

        if (status.status === 'paused' || status.resumable) {
          this.isLoading.set(false);
          this.isSuccess.set(false);
          this.readySessionId.set(null);
          this.applyProgress(status);
          const done = Math.max(0, status.completedUnitIndex ?? (status.unitIndex ?? 1) - 1);
          const total = status.unitTotal || 0;
          const progressNote = total ? ` Saved ${done}/${total} units.` : '';
          this.statusMessage.set(
            `⏸️ ${status.message || 'Free-tier limit reached. Progress is saved.'}${progressNote} Click Continue conversion when you have quota again.`,
          );
          const session: ProjectSession = {
            sessionId,
            projectName: this.selectedFile()?.name?.replace(/\.zip$/i, '') || this.activeProject()?.projectName || 'Migrated Project',
            fromTech: this.fromTech() || this.activeProject()?.fromTech,
            toTech: this.toTech() || this.activeProject()?.toTech,
            aiProvider: this.aiProvider() || this.activeProject()?.aiProvider,
            aiModel: this.aiModel() || this.activeProject()?.aiModel,
            resumable: true,
            paused: true,
            completedUnitIndex: status.completedUnitIndex ?? done,
            unitTotal: total || undefined,
          };
          this.activeProject.set(session);
          this.sessionService.writeSession(session);
          void this.refreshProjectMeta(sessionId);
          return;
        }

        if (status.status === 'completed') {
          if (this.settlingDownload) return;
          this.settlingDownload = true;
          this.progressText.set(
            mode === 'rework'
              ? 'Changes applied. Preparing download...'
              : 'Migration complete. Preparing download...',
          );
          try {
            await this.downloadCompletedSession(sessionId, mode);
          } finally {
            this.settlingDownload = false;
          }
          return;
        }

        // failed — never auto-download or mark success; the ZIP was not created
        this.isLoading.set(false);
        this.isSuccess.set(false);
        this.lastSessionId = null;
        this.readySessionId.set(null);
        const errMsg = status.error || status.message || 'Migration failed.';
        this.progressText.set('Migration failed.');
        this.statusMessage.set(`❌ ${errMsg}`);
      } catch (err: any) {
        console.warn('Status poll failed (will retry):', err?.message || err);
      }
    };

    void tick();
    this.pollTimer = setInterval(() => void tick(), appSettings.pollIntervalMs);
  }

  private async checkExistingProject(): Promise<void> {
    try {
      const stored = this.sessionService.readSession();
      let res: ProjectCheckResponse | null = null;

      if (stored?.sessionId) {
        res = await firstValueFrom(this.migrationService.checkProject(stored.sessionId));
        if (!res?.exists) {
          this.sessionService.clearSession();
          res = null;
        }
      }

      if (!res) {
        res = await firstValueFrom(this.migrationService.checkProject());
      }

      if (res?.exists && res.sessionId) {
        const session = this.toProjectSession(res);
        this.activeProject.set(session);
        this.sessionService.writeSession(session);
      }
    } catch (err) {
      console.warn('Project existence check failed (server may be offline):', err);
      const stored = this.sessionService.readSession();
      if (stored?.sessionId) {
        this.activeProject.set(stored);
      }
    } finally {
      this.checkingProject.set(false);
      if (!this.activeProject()) {
        this.applyQueryParams();
      }
    }
  }

  private async refreshProjectMeta(sessionId: string): Promise<void> {
    try {
      const res = await firstValueFrom(this.migrationService.checkProject(sessionId));
      if (res?.exists && res.sessionId) {
        const session = this.toProjectSession(res);
        this.activeProject.set(session);
        this.sessionService.writeSession(session);
      }
    } catch {
      // Keep the local copy when the refresh fails
    }
  }

  private toProjectSession(res: ProjectCheckResponse): ProjectSession {
    return {
      sessionId: res.sessionId!,
      projectName: res.projectName,
      fromTech: res.fromTech,
      toTech: res.toTech,
      aiProvider: res.aiProvider,
      aiModel: res.aiModel,
      updatedAt: res.updatedAt,
      resumable: res.resumable,
      paused: res.paused,
      completedUnitIndex: res.completedUnitIndex,
      unitTotal: res.unitTotal,
    };
  }
}
