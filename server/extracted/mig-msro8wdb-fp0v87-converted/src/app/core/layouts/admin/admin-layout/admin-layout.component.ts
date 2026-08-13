import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, RouterOutlet } from '@angular/router';

import { AdminTopbarComponent } from '../admin-topbar/admin-topbar.component';
import { AdminLeftbarComponent } from '../admin-leftbar/admin-leftbar.component';

@Component({
  styleUrl: './admin-layout.component.scss',
  selector: 'admin-layout',
  standalone: true,
  imports: [RouterModule, CommonModule, AdminLeftbarComponent, AdminTopbarComponent, RouterOutlet],
  templateUrl: './admin-layout.component.html'
})
export class AdminLayoutComponent {}
