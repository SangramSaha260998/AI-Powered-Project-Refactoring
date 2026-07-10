import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';

export const appConfig: ApplicationConfig = {
  providers: [
    // Use the stable, clean API name here
    provideZonelessChangeDetection(), 
    provideHttpClient()
  ]
};