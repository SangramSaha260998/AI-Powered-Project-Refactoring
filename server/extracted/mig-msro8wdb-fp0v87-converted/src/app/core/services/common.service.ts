import { BehaviorSubject } from 'rxjs';
import { Injectable } from '@angular/core';
export interface IUnsaveFormCheck {
  checkChanges: boolean;
  valueModified: boolean;
  submitForm: boolean;
}

export type SyncStatus = 'idle' | 'syncing' | 'synced';

@Injectable({ providedIn: 'root' })
export class CommonService {
  public aclBroadcastChannel: BroadcastChannel = new BroadcastChannel('aclChannel');

  /* Error interceptor properties */
  public isRefreshingToken = false;
  public tokenSubject: BehaviorSubject<string | null> = new BehaviorSubject<string | null>(null);

  /* token info backup for reuse token */
  private _tokenInfoSubject = new BehaviorSubject<string | null>(null);
  public tokenInfoSource$ = this._tokenInfoSubject.asObservable();

  /* Set access controls *ACL* */
  private accessControls = new BehaviorSubject<IACLResponse[] | null>(null);
  public accessControls$ = this.accessControls.asObservable();

  /* Sync status properties */
  private _syncStatusSubject = new BehaviorSubject<SyncStatus>('idle');
  public syncStatus$ = this._syncStatusSubject.asObservable();
  private syncStatusTimeout: any = null;

  public setAccessControls(data: IACLResponse[], needBroadcast = true) {
    this.accessControls.next(data);
    if (needBroadcast) this.aclBroadcastChannel.postMessage(data);
  }

  public saveTokenInfo(type: string | null) {
    this._tokenInfoSubject.next(type);
  }

  /**
   * Set sync status
   * @param status - The sync status to set
   */
  public setSyncStatus(status: SyncStatus) {
    // Clear any existing timeout
    if (this.syncStatusTimeout) {
      clearTimeout(this.syncStatusTimeout);
      this.syncStatusTimeout = null;
    }
    this._syncStatusSubject.next(status);
  }

  /**
   * Start syncing - sets status to 'syncing'
   */
  public startSyncing() {
    this.setSyncStatus('syncing');
  }

  /**
   * Set synced - sets status to 'synced' and auto-resets to 'idle' after 3 seconds
   */
  public setSynced() {
    this.setSyncStatus('synced');
    // Auto-reset to idle after 3 seconds
    this.syncStatusTimeout = setTimeout(() => {
      this.setSyncStatus('idle');
      this.syncStatusTimeout = null;
    }, 5000);
  }
}
