import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/migration/create/create.component').then(
        (m) => m.CreateMigrationComponent,
      ),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
