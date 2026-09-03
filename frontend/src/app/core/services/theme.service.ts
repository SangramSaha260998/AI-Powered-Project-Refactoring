import { Injectable, signal } from '@angular/core';
import { ThemeMode } from '@shared/models';
import { appSettings } from '@app/config';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<ThemeMode>('light');

  constructor() {
    this.apply(this.resolveInitial());
  }

  toggle(): void {
    this.apply(this.theme() === 'light' ? 'dark' : 'light');
  }

  private resolveInitial(): ThemeMode {
    try {
      const saved = localStorage.getItem(appSettings.storageKeys.theme);
      if (saved === 'light' || saved === 'dark') {
        return saved;
      }
    } catch {
      // Ignore storage access issues
    }

    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
      return 'dark';
    }

    return 'light';
  }

  private apply(mode: ThemeMode): void {
    this.theme.set(mode);
    document.documentElement.setAttribute('data-theme', mode);

    try {
      localStorage.setItem(appSettings.storageKeys.theme, mode);
    } catch {
      // Persistence is optional
    }
  }
}
