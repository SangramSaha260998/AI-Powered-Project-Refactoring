import { RouterModule, RouterOutlet } from '@angular/router';
import { Component } from '@angular/core';

@Component({
  styleUrl: './auth-layout.component.scss',
  selector: 'auth-layout',
  standalone: true,
  imports: [RouterModule, RouterOutlet],
  templateUrl: './auth-layout.component.html'
})
export class AuthLayoutComponent {}
