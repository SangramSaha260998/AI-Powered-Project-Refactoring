import { filter, first } from 'rxjs/operators';
import { ReplaySubject, Subscription } from 'rxjs';
import { Injectable, OnDestroy } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Params, Router } from '@angular/router';

@Injectable({
  providedIn: 'root',
})
export class RouteParamsService implements OnDestroy {
  private subscriptions: Subscription[] = [];
  private routeParamsChangeSource = new ReplaySubject<Params>();
  routeParamsChange$ = this.routeParamsChangeSource.asObservable();

  constructor(
    private _router: Router,
    private _route: ActivatedRoute,
  ) {
    this.subscriptions.push(
      this._router.events.pipe(filter((event) => event instanceof NavigationEnd)).subscribe(() => {
        let r = this._route;
        while (r.firstChild) r = r.firstChild;
        this.subscriptions.push(
          r.params.pipe(first()).subscribe((params: Params) => {
            this.routeParamsChangeSource.next(params);
          }),
        );
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
  }
}
