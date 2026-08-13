import { Observable } from 'rxjs';
import { inject } from '@angular/core';
import { ResolveFn } from '@angular/router';
import { HelperFunctionService } from '../services';

export const viewPermissionResolverFn: ResolveFn<any[] | null> = ():
  | Observable<any[] | null>
  | Promise<any[] | null>
  | any[] => {
  const _helper = inject(HelperFunctionService);

  /**
   * Acl permission resolver
   * Call api for specific user type
   */
  return _helper.checkAllPermission();
};
