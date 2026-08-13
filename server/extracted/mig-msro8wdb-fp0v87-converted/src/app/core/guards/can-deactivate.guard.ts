// import { Observable } from 'rxjs';
// import { CanDeactivateFn, UrlTree } from '@angular/router';

// type CanDeactivateType =
//   | Observable<boolean | UrlTree>
//   | Promise<boolean | UrlTree>
//   | boolean
//   | UrlTree;

// export interface CanComponentDeactivate {
//   canDeactivate: () => CanDeactivateType;
// }

// export const canDeactivateGuard: CanDeactivateFn<CanComponentDeactivate> = (
//   component: CanComponentDeactivate,
// ) => {
//   /**
//    * We have to implements CanComponentDeactivate to use canDeactivateGuard
//    */
//   return component.canDeactivate ? component.canDeactivate() : true;
// };
import { Observable } from 'rxjs';
import {
  CanDeactivateFn,
  UrlTree,
  ActivatedRouteSnapshot,
  RouterStateSnapshot,
} from '@angular/router';

type CanDeactivateType =
  | Observable<boolean | UrlTree>
  | Promise<boolean | UrlTree>
  | boolean
  | UrlTree;

export interface CanComponentDeactivate {
  canDeactivate: (nextUrl?: string) => CanDeactivateType;
}

export const canDeactivateGuard: CanDeactivateFn<CanComponentDeactivate> = (
  component: CanComponentDeactivate,
  currentRoute: ActivatedRouteSnapshot,
  currentState: RouterStateSnapshot,
  nextState?: RouterStateSnapshot,
) => {
  const nextUrl = nextState?.url; //  target route

  return component.canDeactivate ? component.canDeactivate(nextUrl) : true;
};
