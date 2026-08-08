import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class CommonService {
  public isRefreshingToken = false;
  public tokenSubject = new BehaviorSubject<string | null>(null);
  public accessControls$ = new BehaviorSubject<IACLResponse[]>([]);
  public aclBroadcastChannel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('acl')
    : ({ onmessage: null } as unknown as BroadcastChannel);

  setAccessControls(data: IACLResponse[], _broadcast = true): void {
    this.accessControls$.next(data || []);
  }
}
