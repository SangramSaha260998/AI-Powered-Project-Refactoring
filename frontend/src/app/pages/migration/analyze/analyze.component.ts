import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MigrationService } from '@core/http';
import { AnalyzeResponse } from '@shared/models';

@Component({
  selector: 'app-analyze',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './analyze.component.html',
  styleUrl: './analyze.component.scss',
})
export class AnalyzeComponent {
  private readonly migrationService = inject(MigrationService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  analysis = signal<AnalyzeResponse | null>(null);
  isLoading = signal<boolean>(true);
  errorMessage = signal<string>('');

  constructor() {
    void this.loadAnalysis();
  }

  private async loadAnalysis(): Promise<void> {
    const sessionId = this.route.snapshot.paramMap.get('sessionId');
    if (!sessionId) {
      this.errorMessage.set('No session ID provided.');
      this.isLoading.set(false);
      return;
    }
    try {
      const res = await firstValueFrom(
        this.migrationService.analyzeSession(sessionId),
      );
      this.analysis.set(res);
    } catch (err: any) {
      this.errorMessage.set(err?.error?.error || err?.message || 'Failed to load analysis.');
    } finally {
      this.isLoading.set(false);
    }
  }

  startMigration(): void {
    const analysis = this.analysis();
    if (!analysis) return;
    this.router.navigate(['/'], {
      queryParams: { fromTech: analysis.fromTech, toTech: analysis.toTech },
    });
  }
}
