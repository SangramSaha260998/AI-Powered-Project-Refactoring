import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NgxLoadingBarComponent } from '@ngx-loading-bar/core';

@Component({
  styleUrl: './app.component.scss',
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, NgxLoadingBarComponent],
  templateUrl: './app.component.html'
  })
export class AppComponent {}
