import { CommonModule } from '@angular/common';
import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { AuthenticationService } from '@app/core/authentication';
import { CommonService, SyncStatus } from '@app/core/services';
import { AppState } from '@app/store';
import { Store } from '@ngxs/store';
import { filter, Subscription } from 'rxjs';

@Component({
  styleUrl: './admin-topbar.component.scss',
  selector: 'admin-topbar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './admin-topbar.component.html'
})
export class AdminTopbarComponent implements OnInit, OnDestroy {
  private _store = inject(Store);
  private _router = inject(Router);
  private _authService = inject(AuthenticationService);
  private _commonService = inject(CommonService);
  public subHeader = '';
  public mainHeader = '';
  public isDisabled = false;
  private subscriptions: Subscription[] = [];
  public profileImage = '';
  public loginDetails: ILoginDetails | null = null;
  public syncStatus: SyncStatus = 'idle';

  private loginDetails$ = this._store.select(AppState.loginDetails);

  ngOnInit(): void {
    this.getDataFromStore();
    this.subscribeToSyncStatus();
    this.subscribeToRouterEvents();
  }
  getDataFromStore() {
    this.subscriptions.push(
      this.loginDetails$.subscribe((data) => {
        if (data) {
          this.loginDetails = data;
          this.profileImage = this.getAvatarName(this.loginDetails.name);
        }
      }),
    );
  }
  subscribeToSyncStatus() {
    this.subscriptions.push(
      this._commonService.syncStatus$.subscribe((status) => {
        this.syncStatus = status;
      }),
    );
  }
  subscribeToRouterEvents() {
    // Reset sync status when navigation occurs (including back button)
    this.subscriptions.push(
      this._router.events.pipe(filter((event) => event instanceof NavigationEnd)).subscribe(() => {
        // Reset sync status to idle when route changes
        this._commonService.setSyncStatus('idle');
        this.syncStatus = 'idle';
      }),
    );
  }
  getAvatarName(fullName: string): string {
    if (!fullName) return '';

    const parts = fullName.trim().split(/\s+/);

    if (parts.length === 1) {
      return parts[0].charAt(0).toUpperCase();
    }

    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  onLogout(event: Event) {
    event.preventDefault();
    // this timeout to process existing request and then logout
    setTimeout(() => {
      this._authService.logout();
      this._router.navigate(['/']);
    }, 500);
  }
  ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
  }
}
