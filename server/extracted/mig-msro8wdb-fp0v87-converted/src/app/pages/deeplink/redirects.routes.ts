import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/redirects/redirects.component').then((c) => c.RedirectsComponent),
  },
  {
    path: ':deepLinkingShortId',
    loadComponent: () =>
      import('./pages/redirects/redirects.component').then((c) => c.RedirectsComponent),
  },
];
