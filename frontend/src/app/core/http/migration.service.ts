import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { environment } from '@env/environment';
import { appSettings } from '@app/config';
import {
  MigrateStartResponse,
  MigrateStatusResponse,
  ProjectCheckResponse,
  ModelOption,
  AnalyzeResponse,
  VisualQaReport,
} from '@shared/models';

@Injectable({ providedIn: 'root' })
export class MigrationService {
  private readonly http = inject(HttpClient);
  private readonly apiBase = environment.apiBaseUrl;

  startMigration(formData: FormData): Observable<MigrateStartResponse> {
    return this.http
      .post<MigrateStartResponse>(`${this.apiBase}/migrate`, formData)
      .pipe(timeout({ first: appSettings.uploadTimeoutMs }));
  }

  pollStatus(sessionId: string): Observable<MigrateStatusResponse> {
    return this.http
      .get<MigrateStatusResponse>(`${this.apiBase}/migrate/${sessionId}/status`)
      .pipe(timeout({ first: appSettings.statusTimeoutMs }));
  }

  downloadProject(sessionId: string): Observable<Blob> {
    return this.http
      .get(`${this.apiBase}/download/${sessionId}`, { responseType: 'blob' })
      .pipe(timeout({ first: appSettings.downloadTimeoutMs }));
  }

  submitChanges(
    sessionId: string,
    prompt: string,
    aiProvider?: string,
    aiModel?: string,
  ): Observable<MigrateStartResponse> {
    return this.http
      .post<MigrateStartResponse>(`${this.apiBase}/project/${sessionId}/rework`, {
        prompt,
        aiProvider: aiProvider || undefined,
        aiModel: aiModel || undefined,
      })
      .pipe(timeout({ first: appSettings.uploadTimeoutMs }));
  }

  deleteProject(sessionId: string): Observable<unknown> {
    return this.http
      .delete(`${this.apiBase}/project/${sessionId}`)
      .pipe(timeout({ first: appSettings.deleteTimeoutMs }));
  }

  checkProject(sessionId?: string): Observable<ProjectCheckResponse> {
    const url = sessionId
      ? `${this.apiBase}/project/${sessionId}`
      : `${this.apiBase}/project/latest`;
    return this.http
      .get<ProjectCheckResponse>(url)
      .pipe(timeout({ first: appSettings.projectCheckTimeoutMs }));
  }

  loadModels(provider: string): Observable<{ models: ModelOption[] }> {
    return this.http.get<{ models: ModelOption[] }>(`${this.apiBase}/models/${provider}`);
  }

  analyzeProject(formData: FormData): Observable<AnalyzeResponse> {
    return this.http
      .post<AnalyzeResponse>(`${this.apiBase}/analyze`, formData)
      .pipe(timeout({ first: appSettings.uploadTimeoutMs }));
  }

  analyzeSession(sessionId: string, fromTech?: string, toTech?: string): Observable<AnalyzeResponse> {
    const fd = new FormData();
    if (fromTech) fd.append('fromTech', fromTech);
    if (toTech) fd.append('toTech', toTech);
    return this.http
      .post<AnalyzeResponse>(`${this.apiBase}/analyze/${sessionId}`, fd)
      .pipe(timeout({ first: appSettings.uploadTimeoutMs }));
  }

  getVisualQaReport(sessionId: string): Observable<VisualQaReport> {
    return this.http
      .get<VisualQaReport>(`${this.apiBase}/visual-qa/${sessionId}`)
      .pipe(timeout({ first: appSettings.statusTimeoutMs }));
  }
}
