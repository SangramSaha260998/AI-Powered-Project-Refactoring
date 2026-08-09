/**
 * Ensure app.config.ts wires the web_angular interceptors + NGXS store.
 * The template ships a complete app.config.ts, so this only creates a file
 * when it is missing (never overwrites a working config).
 */
function ensureAngularAppConfigUsesWebAngular(destPath) {
  const appConfigPath = path.join(destPath, 'src', 'app', 'app.config.ts');
  if (fs.existsSync(appConfigPath)) {
    const existing = fs.readFileSync(appConfigPath, 'utf-8');
    if (/provideStore\s*\(/.test(existing) && /withInterceptors\s*\(/.test(existing)) {
      return;
    }
  }

  const kitConfig = `import {
  httpErrorInterceptorFn,
  httpAuthHeaderInterceptorFn,
  httpSuccessHandlerInterceptorFn,
} from './core/interceptors';
import { routes } from './app.routes';
import { provideStore } from '@ngxs/store';
import { provideToastr } from 'ngx-toastr';
import { PreloadAllModules, provideRouter, withPreloading } from '@angular/router';
import { environment } from '../environments/environment';
import { withNgxsLoggerPlugin } from '@ngxs/logger-plugin';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { ApplicationConfig, importProvidersFrom, provideZoneChangeDetection } from '@angular/core';
import { AppState } from './store';

const STATES = [AppState];

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withPreloading(PreloadAllModules)),
    provideAnimationsAsync(),
    importProvidersFrom(),
    provideHttpClient(
      withInterceptors([
        httpErrorInterceptorFn,
        httpAuthHeaderInterceptorFn,
        httpSuccessHandlerInterceptorFn,
      ]),
    ),
    provideToastr({
      timeOut: 3000,
      closeButton: true,
      positionClass: 'toast-top-right',
    }),
    provideStore([...STATES], withNgxsLoggerPlugin({ disabled: environment.production })),
  ],
};
`;
  ensureDirectoryExists(path.dirname(appConfigPath));
  fs.writeFileSync(appConfigPath, kitConfig, 'utf-8');
  console.log(`[web_angular] Wrote app.config.ts with interceptors + NGXS store + toastr`);
}
