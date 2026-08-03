import {
  HttpEvent,
  HttpRequest,
  HttpHandlerFn,
  HttpStatusCode,
  HttpErrorResponse,
  HttpInterceptorFn,
} from "@angular/common/http";
import { inject } from "@angular/core";
import { Router } from "@angular/router";
import { appSettings } from "@app/config";
import { environment } from "@env/environment";
import { CommonService, SocketIoService } from "@core/services";
import { throwError, Observable } from "rxjs";
import { AuthenticationService } from "@core/authentication";
import {
  take,
  filter,
  timeout,
  finalize,
  switchMap,
  catchError,
} from "rxjs/operators";

export const httpErrorInterceptorFn: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> => {
  const _router = inject(Router);
  const _common = inject(CommonService);
  const _authService = inject(AuthenticationService);
  const _socketIoService = inject(SocketIoService);
  const timeOut = appSettings.ajaxTimeout;
  const regenerateTokenUrl = `${environment.host}/admin/regenerateToken`;

  return next(req).pipe(
    timeout(timeOut),
    catchError((error) => errorHandler(error, req, next)),
  );

  /* Handling error based on response codes */
  function errorHandler(
    error: HttpErrorResponse,
    req: HttpRequest<any>,
    next: HttpHandlerFn,
  ): Observable<HttpEvent<any>> {
    const httpErrorCode: number = error["status"];
    /* if generate refresh token api get 401(Unauthorized) error just logout */
    if (
      httpErrorCode === HttpStatusCode.Unauthorized &&
      req.url === regenerateTokenUrl
    ) {
      logoutAndResetChat();
      _router.navigate(["/"]);
    }

    switch (httpErrorCode) {
      case HttpStatusCode.BadRequest:
        return throwError(() => error);
      case HttpStatusCode.Unauthorized:
        return handle401Error(req, error, next);
      case HttpStatusCode.Forbidden:
        return handle403Error(error);
      case HttpStatusCode.NotFound:
        return handle404Error(error);
      case HttpStatusCode.InternalServerError:
        return throwError(() => error);
      default:
        return throwError(() => error);
    }
  }

  /* Handling 401 error and getting refresh token */
  function handle401Error(
    request: HttpRequest<any>,
    error: HttpErrorResponse,
    next: HttpHandlerFn,
  ): Observable<HttpEvent<any>> {
    /* If user not logged in no need to handle 401 */
    if (!_authService.isAuthenticated()) {
      logoutAndResetChat();
      _router.navigate(["/"]);
      return throwError(() => error);
    }

    /* if token invalid then call regenerate token ${new token} */
    if (!_common.isRefreshingToken) {
      _common.isRefreshingToken = true;
      // Reset here so that the following requests wait until the token
      // comes back from the refreshToken call.
      _common.tokenSubject.next(null);
      return _authService.getRefreshToken().pipe(
        switchMap((apiResult) => {
          const data: Omit<ITokenInfo, "enc_email"> = apiResult.response.data;
          _authService.updateRefreshedToken(data);
          _socketIoService.reconnectWithLatestToken();

          _common.tokenSubject.next(data.access_token);
          return next(addTokenInHeader(request, data.access_token));
        }),
        catchError((error) => {
          // If there is an exception calling 'refreshToken', bad news so logout.
          if (error.url === regenerateTokenUrl) {
            logoutAndResetChat();
            _router.navigate(["/"]);
          } else {
            _common.isRefreshingToken = false;
          }
          return throwError(() => error);
        }),
        finalize(() => {
          _common.isRefreshingToken = false;
        }),
      );
    } else {
      return _common.tokenSubject.pipe(
        filter((token) => token !== null),
        take(1),
        switchMap((token) => {
          return next(addTokenInHeader(request, token));
        }),
      );
    }
  }

  /* Handle 403 error */
  function handle403Error(error: HttpErrorResponse): Observable<any> {
    _router.navigate(["/forbidden"]); // redirect to forbidden page
    return throwError(() => error);
  }

  /* Handle 404 error */
  function handle404Error(error: HttpErrorResponse): Observable<any> {
    _router.navigate(["/not-found"]); // redirect to 404 page not found
    return throwError(() => error);
  }

  function logoutAndResetChat(): void {
    _socketIoService.disconnect();
    _socketIoService.clearConversationState();
    _authService.logout();
  }

  /* Adding new token in request header */
  function addTokenInHeader(
    req: HttpRequest<any>,
    token: string | null,
  ): HttpRequest<any> {
    return token !== null
      ? req.clone({
          setHeaders: { Authorization: "Bearer " + token },
        })
      : req;
  }
};
