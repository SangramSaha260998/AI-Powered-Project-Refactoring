import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'login',
  },
  {
    path: 'login',
    title: 'Login',
    loadComponent: () => import('./auth/pages').then((c) => c.LoginComponent),
  },
  {
    path: 'forgot-password',
    title: 'Forgot Password',
    loadComponent: () =>
      import('./auth/pages/forgot-password/forgot-password.component').then(
        (c) => c.ForgotPasswordComponent,
      ),
  },
  {
    path: 'enter-otp',
    title: 'OTP Verification',
    loadComponent: () =>
      import('./auth/pages/enter-otp/enter-otp.component').then((c) => c.EnterOtpComponent),
  },
  {
    path: 'reset-password',
    title: 'Reset Password',
    loadComponent: () =>
      import('./auth/pages/reset-password/reset-password.component').then(
        (c) => c.ResetPasswordComponent,
      ),
  },
  {
    path: 'create-new-password',
    title: 'Create Password',
    loadComponent: () =>
      import('./auth/pages/create-new-password/create-new-password.component').then(
        (c) => c.CreateNewPasswordComponent,
      ),
  },
];
