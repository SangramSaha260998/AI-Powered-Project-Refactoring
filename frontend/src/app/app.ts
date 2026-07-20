import { Component, ElementRef, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { LoadingOverlayDirective } from './directives';

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
    { id: 'stepfun', label: 'Stepfun' },
    { id: 'genai', label: 'Google Gemini' },
    { id: 'ollama', label: 'Ollama (Local)' },
  ];

  // Models per provider
  providerModels: Record<string, string[]> = {
    stepfun: ['step-3.7-flash', 'step-3.5-flash', 'step-1-flash'],
    genai: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
    ollama: [
      'llama3.1', 'llama3', 'mistral', 'codellama',
      'deepseek-coder', 'mixtral', 'phi3', 'gemma2',
      'qwen2', 'qwen2.5-coder:7b', 'qwen2.5-coder:3b',
      'qwen2.5-coder:1.5b', 'deepseek-r1'
    ],
  };

  // Modern Angular Signals replacing classic variables
  fromTech = signal<string>('');
  toTech = signal<string>('');
  aiProvider = signal<string>('stepfun');
  aiModel = signal<string>('');
  isDragging = signal<boolean>(false);
  selectedFile = signal<File | null>(null);
  prompt = signal<string>('');
  isLoading = signal<boolean>(false);
  statusMessage = signal<string>('');
  isSuccess = signal<boolean>(false);

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

  constructor(private http: HttpClient) {}

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
  }

  onModelChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.aiModel.set(value);
  }

  /** Returns models for the currently selected provider. */
  get currentModels(): string[] {
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
    }
  }

  /** Reset form controls after a successful migration download. */
  private clearUiAfterSuccess() {
    this.fromTech.set('');
    this.toTech.set('');
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

    // Clear the status message after 3 seconds
    setTimeout(() => {
      this.statusMessage.set('');
    }, 3000);
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
      return;
    }
    // if (from === to) {
    //   this.isSuccess.set(false);
    //   this.statusMessage.set('❌ Source and target frameworks must be different.');
    //   return;
    // }
    if (!promptText) {
      this.isSuccess.set(false);
      this.statusMessage.set('❌ Please enter a migration prompt.');
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
      .post('http://localhost:5000/api/migrate', formData, {
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
}
