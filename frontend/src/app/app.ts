import { Component, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  // Your custom framework values dictionary
  technologies = [
    { id: 1, technology: 'Angular' },
    { id: 2, technology: 'React' }
  ];

  // Modern Angular Signals replacing classic variables
  fromTech = signal<string>('Angular');
  toTech = signal<string>('React');
  isDragging = signal<boolean>(false);
  selectedFile = signal<File | null>(null);
  isLoading = signal<boolean>(false);
  statusMessage = signal<string>('');
  isSuccess = signal<boolean>(false);

  constructor(private http: HttpClient) {}

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
    } else {
      this.isSuccess.set(false);
      this.statusMessage.set('❌ Invalid file format. Please drop a valid zipped archive.');
      this.selectedFile.set(null);
    }
  }

  uploadProject() {
    const file = this.selectedFile();
    if (!file) return;

    this.isLoading.set(true);
    this.statusMessage.set('Uploading package and resolving dependencies...');

    const formData = new FormData();
    formData.append('projectZip', file);
    formData.append('fromTech', this.fromTech());
    formData.append('toTech', this.toTech());

    // Send payload to our Express engine route
    this.http.post('http://localhost:5000/api/upload', formData).subscribe({
      next: (response: any) => {
        this.isLoading.set(false);
        this.isSuccess.set(true);
        this.statusMessage.set(`🎉 Success: ${response.message}`);
      },
      error: (err) => {
        this.isLoading.set(false);
        this.isSuccess.set(false);
        this.statusMessage.set('❌ Pipeline execution failed. Verify server terminal connection.');
        console.error(err);
      }
    });
  }
}