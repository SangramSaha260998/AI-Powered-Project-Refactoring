import { Component, ElementRef, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { LoadingOverlayDirective } from './directives';
type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'migration-studio-theme';

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

  // Modern Angular Signals replacing classic variables
  fromTech = signal<string>('');
  toTech = signal<string>('');
  isDragging = signal<boolean>(false);
  selectedFile = signal<File | null>(null);
  prompt = signal<string>('');
  isLoading = signal<boolean>(false);
  statusMessage = signal<string>('');
  isSuccess = signal<boolean>(false);
  theme = signal<ThemeMode>('light');

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

  onFromChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.fromTech.set(value);
  }

  onToChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.toTech.set(value);
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

  clearMessage() {
    // Clear the status message after 3 seconds
    setTimeout(() => {
      this.statusMessage.set('');
    }, 3000);
  }
}
