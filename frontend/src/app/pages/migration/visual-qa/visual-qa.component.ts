import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MigrationService } from '@core/http';
import { VisualQaReport } from '@shared/models';

@Component({
  selector: 'app-visual-qa',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './visual-qa.component.html',
  styleUrl: './visual-qa.component.scss',
})
export class VisualQaComponent {
  private readonly migrationService = inject(MigrationService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  report = signal<VisualQaReport | null>(null);
  isLoading = signal<boolean>(true);
  errorMessage = signal<string>('');
  selectedRoute = signal<string>('');

  constructor() {
    void this.loadReport();
  }

  get selectedComparison() {
    const rep = this.report();
    if (!rep) return null;
    const route = this.selectedRoute() || rep.comparisons[0]?.route;
    return rep.comparisons.find((c) => c.route === route) || null;
  }

  private async loadReport(): Promise<void> {
    const sessionId = this.route.snapshot.paramMap.get('sessionId');
    if (!sessionId) {
      this.errorMessage.set('No session ID provided.');
      this.isLoading.set(false);
      return;
    }
    try {
      const res = await firstValueFrom(this.migrationService.getVisualQaReport(sessionId));
      this.report.set(res);
      if (res.comparisons.length > 0) {
        this.selectedRoute.set(res.comparisons[0].route);
      }
    } catch (err: any) {
      this.errorMessage.set(
        err?.error?.error || err?.message || 'Failed to load visual QA report.',
      );
    } finally {
      this.isLoading.set(false);
    }
  }

  selectRoute(route: string): void {
    this.selectedRoute.set(route);
  }

  goBack(): void {
    this.router.navigate(['/']);
  }
}
