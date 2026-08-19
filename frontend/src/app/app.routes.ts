import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/migration/create/create.component').then((m) => m.CreateMigrationComponent),
  },
  {
    path: 'analyze/:sessionId',
    loadComponent: () =>
      import('./pages/migration/analyze/analyze.component').then((m) => m.AnalyzeComponent),
  },
  {
    path: 'visual-qa/:sessionId',
    loadComponent: () =>
      import('./pages/migration/visual-qa/visual-qa.component').then((m) => m.VisualQaComponent),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
