import { Component, ElementRef, OnDestroy, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { firstValueFrom, Subscription, timeout } from 'rxjs';
import { LoadingOverlayDirective } from './directives';

type ThemeMode = 'light' | 'dark';
type ModelOption = { id: string; label: string };
type VersionOption = { major: number; label: string; version: string };
type MigrateStartResponse = {
  sessionId: string;
  status: string;
  message?: string;
  statusUrl?: string;
  downloadUrl?: string;
};
type MigrateStatusResponse = {
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

const THEME_STORAGE_KEY = 'migration-studio-theme';
const API_BASE = 'http://localhost:5000/api';
const STATUS_POLL_MS = 2000;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [DecimalPipe, LoadingOverlayDirective],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy {
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  // Your custom framework values dictionary
  technologies = [
    { id: 1, technology: 'Angular' },
    { id: 2, technology: 'React' },
  ];

  // Available versions per framework
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

  // AI providers configuration
  aiProviders = [
    { id: 'openrouter', label: 'OpenRouter' },
    { id: 'genai', label: 'Google Gemini' },
    { id: 'groq', label: 'Groq' },
    { id: 'ollama', label: 'Ollama Cloud' },
  ];

  // Models per provider (loaded dynamically when a provider is selected)
  providerModels: Record<string, ModelOption[]> = {
    openrouter: [],
    genai: [],
    groq: [],
    ollama: [],
  };

  // Modern Angular Signals replacing classic variables
  fromTech = signal<string>('');
  toTech = signal<string>('');
  aiProvider = signal<string>('');
  aiModel = signal<string>('');
  targetVersion = signal<string>('');
  isDragging = signal<boolean>(false);
  selectedFile = signal<File | null>(null);
  prompt = signal<string>('');
  isLoading = signal<boolean>(false);
  statusMessage = signal<string>('');
  isSuccess = signal<boolean>(false);
  theme = signal<ThemeMode>('light');
  modelsLoading = signal<boolean>(false);
  /** Live overlay / status text while migration runs */
  progressText = signal<string>('Running AI migration pipeline...');
  /** Completed session ready for manual download (rare edge case) */
  readySessionId = signal<string | null>(null);

  /** Bumps when provider models are refreshed so the model select re-renders. */
  private modelsVersion = signal(0);

  /** Active migration session id */
  private lastSessionId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startSub: Subscription | null = null;
  private settlingDownload = false;

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

  constructor(private http: HttpClient) {
    this.applyTheme(this.resolveInitialTheme());
  }

  ngOnDestroy() {
    this.stopPolling();
    this.startSub?.unsubscribe();
  }

  private isDynamicProvider(provider: string): boolean {
    return provider === 'openrouter' || provider === 'genai' || provider === 'groq' || provider === 'ollama';
  }

  /** Fetch models for a provider via the backend proxy. */
  private loadProviderModels(provider: string) {
    if (!this.isDynamicProvider(provider)) return;

    this.modelsLoading.set(true);
    this.http.get<{ models: ModelOption[] }>(`${API_BASE}/models/${provider}`).subscribe({
      next: (res) => {
        this.providerModels[provider] = res.models ?? [];
        this.modelsVersion.update((v) => v + 1);
        this.modelsLoading.set(false);

        if (this.aiProvider() === provider) {
          const current = this.aiModel();
          if (current && !this.providerModels[provider].some((m) => m.id === current)) {
            this.aiModel.set('');
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

  toggleTheme() {
    this.applyTheme(this.theme() === 'light' ? 'dark' : 'light');
  }

  private resolveInitialTheme(): ThemeMode {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'light' || saved === 'dark') {
        return saved;
      }
    } catch {
      // Ignore storage access issues and fall back to preference / light.
    }

    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
      return 'dark';
    }

    return 'light';
  }

  private applyTheme(mode: ThemeMode) {
    this.theme.set(mode);
    document.documentElement.setAttribute('data-theme', mode);

    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Persistence is optional.
    }
  }

  /** Default prompt for same-framework (strip-down) mode */
  private readonly defaultStripDownPrompt = `STRIP DOWN PROJECT — KEEP ONLY AUTH + DASHBOARD

DELETE all components/files EXCEPT:
- Auth module (login, register, forgot password, OTP, password reset)
- Dashboard page and its sub-components
- Core app shell (App component, routing, main layout)
- Shared services (auth service, guards, HTTP interceptors)

REMOVE entirely:
- Profile/settings/user-management pages
- Listing/table/CRUD pages for any entities
- Blog, about, contact, landing pages
- Demo/placeholder/skeleton components

UPDATE routing: login as default route, dashboard post-login, auth guard on protected routes.

Final app must compile and run: npm install → ng serve`;

  onFromChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.fromTech.set(value);
    this.autoFillPromptIfSameFramework();
  }

  onToChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.toTech.set(value);
    // Reset version when framework changes
    this.targetVersion.set('');
    this.autoFillPromptIfSameFramework();
  }

  onVersionChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.targetVersion.set(value);
  }

  /** Returns available versions for the currently selected target framework. */
  get currentVersions(): VersionOption[] {
    return this.frameworkVersions[this.toTech()] || [];
  }

  /** Pre-fill the default strip-down prompt when source === target framework */
  private autoFillPromptIfSameFramework() {
    const from = this.fromTech();
    const to = this.toTech();
    if (from && to && from.toLowerCase() === to.toLowerCase()) {
      // Only auto-fill if the user hasn't typed their own custom prompt
      if (!this.prompt() || this.prompt() === this.defaultStripDownPrompt) {
        this.prompt.set(this.defaultStripDownPrompt);
      }
    }
  }

  onProviderChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.aiProvider.set(value);
    // Reset model selection when provider changes
    this.aiModel.set('');

    if (
      this.isDynamicProvider(value) &&
      this.providerModels[value].length === 0 &&
      !this.modelsLoading()
    ) {
      this.loadProviderModels(value);
    }
  }

  onModelChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.aiModel.set(value);
  }

  /** Returns models for the currently selected provider. */
  get currentModels(): ModelOption[] {
    // Touch version signal so async model updates refresh the template.
    this.modelsVersion();
    return this.providerModels[this.aiProvider()] || [];
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    this.isDragging.set(true);
  }

  onDragLeave() {
    this.isDragging.set(false);
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    this.isDragging.set(false);
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.validateAndSetFile(files[0]);
    }
  }

  onPromptChange(event: Event) {
    const value = (event.target as HTMLTextAreaElement).value;
    this.prompt.set(value);
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.validateAndSetFile(input.files[0]);
    }
  }

  private validateAndSetFile(file: File) {
    if (file.name.endsWith('.zip')) {
      this.selectedFile.set(file);
      this.statusMessage.set('');
      this.isSuccess.set(false);
      this.readySessionId.set(null);
    } else {
      this.isSuccess.set(false);
      this.statusMessage.set('❌ Invalid file format. Please drop a valid zipped archive.');
      this.selectedFile.set(null);
      this.clearMessage();
    }
  }

  /** Reset form controls after a successful migration download. */
  private clearUiAfterSuccess() {
    this.fromTech.set('');
    this.toTech.set('');
    this.targetVersion.set('');
    this.aiProvider.set('');
    this.aiModel.set('');
    this.prompt.set('');
    this.selectedFile.set(null);
    this.isDragging.set(false);
    this.isLoading.set(false);
    this.isSuccess.set(true);
    this.readySessionId.set(null);
    this.progressText.set('Running AI migration pipeline...');
    this.statusMessage.set('🎉 Migration complete! ZIP downloaded successfully.');

    const input = this.fileInput()?.nativeElement;
    if (input) {
      input.value = '';
    }

    this.clearMessage();
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private formatElapsed(ms?: number): string {
    if (!ms || ms < 0) return '';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min <= 0) return `${sec}s`;
    return `${min}m ${sec.toString().padStart(2, '0')}s`;
  }

  private applyProgress(status: MigrateStatusResponse) {
    const elapsed = this.formatElapsed(status.elapsedMs);
    const unitBit =
      status.unitIndex && status.unitTotal
        ? ` (${status.unitIndex}/${status.unitTotal})`
        : '';
    const base = status.message || 'Migrating...';
    const text = elapsed ? `${base}${unitBit} · ${elapsed}` : `${base}${unitBit}`;
    this.progressText.set(text);
    this.statusMessage.set(`⏳ ${text}`);
  }

  private triggerBlobDownload(blob: Blob, filename = 'migrated_project.zip') {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }

  private async downloadCompletedSession(sessionId: string) {
    this.progressText.set('Downloading migrated project...');
    this.statusMessage.set('⏳ Downloading migrated project...');

    try {
      const blob = await firstValueFrom(
        this.http
          .get(`${API_BASE}/download/${sessionId}`, { responseType: 'blob' })
          .pipe(timeout({ first: 5 * 60 * 1000 }))
      );
      this.triggerBlobDownload(blob);
      this.lastSessionId = null;
      this.clearUiAfterSuccess();
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

  private startStatusPolling(sessionId: string) {
    this.stopPolling();

    const tick = async () => {
      try {
        const status = await firstValueFrom(
          this.http
            .get<MigrateStatusResponse>(`${API_BASE}/migrate/${sessionId}/status`)
            .pipe(timeout({ first: 30_000 }))
        );

        if (status.status === 'queued' || status.status === 'running') {
          this.applyProgress(status);
          return;
        }

        this.stopPolling();

        if (status.status === 'completed') {
          if (this.settlingDownload) return;
          this.settlingDownload = true;
          this.progressText.set('Migration complete. Preparing download...');
          try {
            await this.downloadCompletedSession(sessionId);
          } finally {
            this.settlingDownload = false;
          }
          return;
        }

        // failed
        this.isLoading.set(false);
        this.isSuccess.set(false);
        this.lastSessionId = null;
        this.readySessionId.set(null);
        this.statusMessage.set(`❌ ${status.error || status.message || 'Migration failed.'}`);
      } catch (err: any) {
        // Transient poll errors — keep waiting; do not abort the server job
        console.warn('Status poll failed (will retry):', err?.message || err);
      }
    };

    void tick();
    this.pollTimer = setInterval(() => void tick(), STATUS_POLL_MS);
  }

  uploadProject() {
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

    // Async migrate: server returns 202 immediately, then we poll until done
    this.startSub = this.http
      .post<MigrateStartResponse>(`${API_BASE}/migrate`, formData)
      .pipe(timeout({ first: 2 * 60 * 1000 })) // upload + validation only
      .subscribe({
        next: (res) => {
          const sessionId = res.sessionId || this.lastSessionId!;
          this.lastSessionId = sessionId;
          this.progressText.set(res.message || 'Migration started...');
          this.statusMessage.set(`⏳ ${res.message || 'Migration started...'}`);
          this.startStatusPolling(sessionId);
        },
        error: async (err) => {
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

  /**
   * Manual download if auto-download failed after a completed migration.
   */
  downloadReadySession() {
    const sessionId = this.readySessionId();
    if (!sessionId) return;
    this.isLoading.set(true);
    void this.downloadCompletedSession(sessionId);
  }

  dismissReadyDownload() {
    this.readySessionId.set(null);
    this.lastSessionId = null;
    this.statusMessage.set('');
  }

  /**
   * Clears transient status messages after a short delay.
   * Does NOT clear while loading or when a ready download is pending.
   */
  clearMessage() {
    if (this.isLoading() || this.readySessionId()) return;

    setTimeout(() => {
      if (!this.isLoading() && !this.readySessionId()) {
        this.statusMessage.set('');
      }
    }, 4000);
  }
}
