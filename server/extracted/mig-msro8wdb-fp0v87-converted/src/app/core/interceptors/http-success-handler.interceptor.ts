import {
  HttpEvent,
  HttpRequest,
  HttpResponse,
  HttpHandlerFn,
  HttpInterceptorFn,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { CryptoService } from '../services';
import { environment } from '@env/environment';
import { from, map, mergeMap, Observable, switchMap } from 'rxjs';

export const httpSuccessHandlerInterceptorFn: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> => {
  const _cryptoService = inject(CryptoService);
  const encryptedRequest = environment?.encryption.encryptedRequest ?? false;

  if (
    encryptedRequest &&
    !!req.body &&
    !(req.body instanceof FormData) &&
    req.url !== './assets/i18n/en.json' &&
    (req.body as Record<string, any>)['enc_data'] === undefined
  ) {
    return from(_cryptoService.encrypt(req.body as Record<string, any>)).pipe(
      mergeMap((encryptedString) => {
        (req.body as Record<string, any>) = {
          enc_data: encryptedString,
        };
        return handleRequest(req);
      }),
    );
  } else {
    return handleRequest(req);
  }

  /* Intercepting success requests */
  function handleRequest(request: HttpRequest<any>) {
    return next(request).pipe(
      switchMap((response: HttpEvent<any>) => {
        if (response instanceof HttpResponse) {
          const statusCode: number = response.status;
          const responseObject = response.body;
          if (!responseObject || typeof responseObject !== 'object') {
            return from([response]);
          }

          responseObject.status = statusCode;

          if (
            response.body?.response !== undefined &&
            response.body?.response?.data !== undefined &&
            response.body?.response?.data['enc_data'] !== undefined &&
            typeof response.body?.response?.data['enc_data'] === 'string'
          ) {
            // Decrypt data and return an observable
            return from(_cryptoService.decrypt(response.body.response.data['enc_data'])).pipe(
              map((decryptedData) => {
                responseObject.response = {
                  ...response.body.response,
                  data: decryptedData,
                };
                return response.clone({ body: responseObject });
              }),
            );
          }
        }

        // If no decryption is needed, return the response as is
        return from([response]);
      }),
    );
  }
};
