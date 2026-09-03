import { Injectable } from '@angular/core';
import { ProjectSession } from '@shared/models';
import { appSettings } from '@app/config';

@Injectable({ providedIn: 'root' })
export class SessionService {
  readSession(): ProjectSession | null {
    try {
      const raw = localStorage.getItem(appSettings.storageKeys.session);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  writeSession(session: ProjectSession): void {
    try {
      localStorage.setItem(appSettings.storageKeys.session, JSON.stringify(session));
    } catch {
      // Persistence is optional
    }
  }

  clearSession(): void {
    try {
      localStorage.removeItem(appSettings.storageKeys.session);
    } catch {
      // Ignore storage issues
    }
  }
}
