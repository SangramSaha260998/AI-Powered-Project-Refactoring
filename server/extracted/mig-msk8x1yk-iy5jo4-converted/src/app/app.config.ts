import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideStore } from '@ngxs/store';
import { routes } from './app.routes';
import { AppState } from './store';
import {
  httpAuthHeaderInterceptorFn,
  httpErrorInterceptorFn,
  httpSuccessHandlerInterceptorFn
} from './core/interceptors';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideAnimationsAsync(),
    provideHttpClient(
      withInterceptors([
        httpAuthHeaderInterceptorFn,
        httpErrorInterceptorFn,
        httpSuccessHandlerInterceptorFn
      ])
    ),
    provideStore([AppState])
  ]
};
