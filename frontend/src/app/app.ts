import { Component, ElementRef, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { LoadingOverlayDirective } from './directives';

type ThemeMode = 'light' | 'dark';
type ModelOption = { id: string; label: string };

const THEME_STORAGE_KEY = 'migration-studio-theme';
const API_BASE = 'http://localhost:5000/api';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [DecimalPipe, LoadingOverlayDirective],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  // Your custom framework values dictionary
  technologies = [
    { id: 1, technology: 'Angular' },
    { id: 2, technology: 'React' },
  ];

  // AI providers configuration
  aiProviders = [
    { id: 'openrouter', label: 'OpenRouter' },
    { id: 'genai', label: 'Google Gemini' },
    { id: 'ollama', label: 'Ollama (Local)' },
  ];

  // Models per provider (openrouter is loaded dynamically from OpenRouter free models)
  providerModels: Record<string, ModelOption[]> = {
    openrouter: [],
    genai: [
      { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash' },
      { id: 'gemini-1.5-flash', label: 'gemini-1.5-flash' },
      { id: 'gemini-1.5-pro', label: 'gemini-1.5-pro' },
    ],
    ollama: [
      { id: 'llama3.1', label: 'llama3.1' },
      { id: 'llama3', label: 'llama3' },
      { id: 'mistral', label: 'mistral' },
      { id: 'codellama', label: 'codellama' },
      { id: 'deepseek-coder', label: 'deepseek-coder' },
      { id: 'mixtral', label: 'mixtral' },
      { id: 'phi3', label: 'phi3' },
      { id: 'gemma2', label: 'gemma2' },
      { id: 'qwen2', label: 'qwen2' },
      { id: 'qwen2.5-coder:7b', label: 'qwen2.5-coder:7b' },
      { id: 'qwen2.5-coder:3b', label: 'qwen2.5-coder:3b' },
      { id: 'qwen2.5-coder:1.5b', label: 'qwen2.5-coder:1.5b' },
      { id: 'deepseek-r1', label: 'deepseek-r1' },
    ],
  };

  // Modern Angular Signals replacing classic variables
  fromTech = signal<string>('');
  toTech = signal<string>('');
  aiProvider = signal<string>('');
  aiModel = signal<string>('');
  isDragging = signal<boolean>(false);
  selectedFile = signal<File | null>(null);
  prompt = signal<string>('');
  isLoading = signal<boolean>(false);
  statusMessage = signal<string>('');
  isSuccess = signal<boolean>(false);
  theme = signal<ThemeMode>('light');
  openrouterModelsLoading = signal<boolean>(false);
  /** Bumps when openrouter models are refreshed so the model select re-renders. */
  private openrouterModelsVersion = signal(0);

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

  /** Fetch free OpenRouter models via the backend proxy. */
  private loadOpenRouterModels() {
    this.openrouterModelsLoading.set(true);
    this.http.get<{ models: ModelOption[] }>(`${API_BASE}/models/openrouter`).subscribe({
      next: (res) => {
        this.providerModels['openrouter'] = res.models ?? [];
        this.openrouterModelsVersion.update((v) => v + 1);
        this.openrouterModelsLoading.set(false);

        // Keep current selection if still available; otherwise clear it.
        if (this.aiProvider() === 'openrouter') {
          const current = this.aiModel();
          if (current && !this.providerModels['openrouter'].some((m) => m.id === current)) {
            this.aiModel.set('');
          }
        }
      },
      error: (err) => {
        console.error('Failed to load OpenRouter free models:', err);
        this.providerModels['openrouter'] = [];
        this.openrouterModelsVersion.update((v) => v + 1);
        this.openrouterModelsLoading.set(false);
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
    this.autoFillPromptIfSameFramework();
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
      value === 'openrouter' &&
      this.providerModels['openrouter'].length === 0 &&
      !this.openrouterModelsLoading()
    ) {
      this.loadOpenRouterModels();
    }
  }

  onModelChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.aiModel.set(value);
  }

  /** Returns models for the currently selected provider. */
  get currentModels(): ModelOption[] {
    // Touch version signal so openrouter async updates refresh the template.
    this.openrouterModelsVersion();
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
    this.aiProvider.set('');
    this.aiModel.set('');
    this.prompt.set('');
    this.selectedFile.set(null);
    this.isDragging.set(false);
    this.isLoading.set(false);
    this.isSuccess.set(true);
    this.statusMessage.set('🎉 Migration complete! ZIP downloaded successfully.');

    const input = this.fileInput()?.nativeElement;
    if (input) {
      input.value = '';
    }

    this.clearMessage();
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
    if (this.aiProvider() === 'openrouter' && !this.aiModel()) {
      this.isSuccess.set(false);
      this.statusMessage.set('❌ Please select an OpenRouter model.');
      this.clearMessage();
      return;
    }
    if (!promptText) {
      this.isSuccess.set(false);
      this.statusMessage.set('❌ Please enter a migration prompt.');
      this.clearMessage();
      return;
    }

    this.isLoading.set(true);
    this.isSuccess.set(false);

    const formData = new FormData();
    formData.append('zipFile', file);
    formData.append('fromTech', from);
    formData.append('toTech', to);
    formData.append('prompt', promptText);
    formData.append('aiProvider', this.aiProvider());
    if (this.aiModel()) {
      formData.append('aiModel', this.aiModel());
    }

    // Send payload to our Express migration engine (returns a downloadable ZIP blob)
    this.http
      .post(`${API_BASE}/migrate`, formData, {
        responseType: 'blob',
      })
      .subscribe({
        next: (blob: Blob) => {
          // Trigger browser download of the returned ZIP
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'migrated_project.zip';
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.URL.revokeObjectURL(url);

          // Clear the form only after a successful API response + download trigger
          this.clearUiAfterSuccess();
        },
        error: async (err) => {
          this.isLoading.set(false);
          this.isSuccess.set(false);

          let errorMessage = 'Unknown server error';
          if (err.error instanceof Blob) {
            try {
              const text = await err.error.text();
              const parsed = JSON.parse(text);
              errorMessage = parsed.error || errorMessage;
            } catch {
              errorMessage = err.message || errorMessage;
            }
          } else {
            errorMessage = err?.error?.error || err?.message || errorMessage;
          }

          this.statusMessage.set(`❌ ${errorMessage}`);
          console.error(err);
        },
      });
  }

  clearMessage() {
    // Clear the status message after 3 seconds
    setTimeout(() => {
      this.statusMessage.set('');
    }, 3000);
  }
}
