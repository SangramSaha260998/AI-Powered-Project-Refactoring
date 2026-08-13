import { map, mergeMap, Observable, of, take } from 'rxjs';
import { inject } from '@angular/core';
import { Router, UrlTree, CanActivateFn } from '@angular/router';
import { AuthenticationService } from '../authentication/authentication.service';
import { AppState, SetLoginDetails } from '@app/store';
import { Store } from '@ngxs/store';

export const authGuard: CanActivateFn = ():
  | boolean
  | UrlTree
  | Observable<boolean | UrlTree>
  | Promise<boolean | UrlTree> => {
  const _store = inject(Store);
  const _router = inject(Router);
  const _authService = inject(AuthenticationService);
  const loginDetails$ = _store.select(AppState.loginDetails);
  /**
   * *Auth Guard to prevent unauthorized user
   */
  const isLoggedIn = _authService.isAuthenticated();
  return loginDetails$.pipe(
    take(1),
    mergeMap((_loginDetails) => {
      if (isLoggedIn && _loginDetails == null) {
        // fetch profile from backend
        return _authService.loginDetails();
      } else {
        // already have profile or not logged in
        return of(_loginDetails);
      }
    }),
    map((__loginDetails: any) => {
      if (isLoggedIn && __loginDetails && __loginDetails.response?.data) {
        _store.dispatch(new SetLoginDetails(__loginDetails.response.data));
      }

      if (isLoggedIn) {
        return true;
      } else {
        _router.navigate(['/']);
        return false;
      }
    }),
  );
  // if (isLoggedIn) {
  //   // authorized so return true
  //   return true;
  // }

  // // not logged in so redirect to login page
  // _router.navigate(['/']);
  // return false;
};
