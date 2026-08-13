import {
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
    // manually added providers
    importProvidersFrom(),
    provideHttpClient(
      // withFetch(),
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
