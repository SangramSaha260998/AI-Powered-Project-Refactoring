import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, OnDestroy, OnInit } from '@angular/core';
import { AppState } from '@app/store';
import { Store } from '@ngxs/store';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardComponent implements OnInit, OnDestroy {
  private _store = inject(Store);
  public loginDetails: ILoginDetails | null = null;
  private subscriptions: Subscription[] = [];

  ngOnInit(): void {
    this.subscribeToLoginDetails();
  }

  private subscribeToLoginDetails() {
    this.subscriptions.push(
      this._store.select(AppState.loginDetails).subscribe((data) => {
        this.loginDetails = data;
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
  }
}
