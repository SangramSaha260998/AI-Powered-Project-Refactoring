import { inject } from "@angular/core";
import { LoadingBarService } from "@ngx-loading-bar/core";
import { Observable, catchError, finalize, throwError } from "rxjs";
import { AuthenticationService } from "../authentication/authentication.service";
import {
  HttpEvent,
  HttpRequest,
  HttpHandlerFn,
  HttpInterceptorFn,
  HttpContextToken,
} from "@angular/common/http";
//Disable loader for specific API
export const SHOW_API_LOADER = new HttpContextToken<boolean>(() => true);

export const httpAuthHeaderInterceptorFn: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> => {
  const _loadingBar = inject(LoadingBarService);
  const _authService = inject(AuthenticationService);

  /* Adding Authorization token in header */
  const headersConfig: Record<string, string> = {};

  /* If token found setting it in header */
  const token: string = _authService.getToken();

  /* Disable loader for specific API */
  const showLoader = req.context.get(SHOW_API_LOADER);
  if (token) {
    headersConfig["Authorization"] = "Bearer " + token;
  }

  if (showLoader) {
    _loadingBar.useRef().start();
  }
  const HTTPRequest = req.clone({ setHeaders: headersConfig });

  return next(HTTPRequest).pipe(
    finalize(() => _loadingBar.useRef().complete()),
    catchError((error: any) => {
      if (showLoader) {
        _loadingBar.useRef().complete();
      }
      return throwError(() => error);
    }),
  );
};

/* With no loader how to use:
*
this.http.post('/api/logs', body, { context: noLoader() });
this.http.get('/api/logs', { context: noLoader() });
*/
