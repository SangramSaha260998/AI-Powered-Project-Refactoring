import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timer, retry, catchError, of } from 'rxjs';
import { environment } from '@env/environment';
import { appSettings } from '@app/config';

@Injectable({ providedIn: 'root' })
export class BackendHealthService {
  private readonly http = inject(HttpClient);

  /**
   * Ping the API so Render free tier wakes before uploads/migrations.
   * Failures are ignored — polling and user actions will retry.
   */
  async warmUp(): Promise<void> {
    const base = environment.apiBaseUrl.replace(/\/api\/?$/, '');
    const url = `${base}/api/health`;
    try {
      await firstValueFrom(
        this.http.get(url).pipe(
          retry({
            count: appSettings.backendWarmupRetries,
            delay: (_err, retryCount) => timer(appSettings.backendWarmupDelayMs * retryCount),
          }),
          catchError(() => of(null)),
        ),
      );
    } catch {
      /* non-fatal */
    }
  }
}
