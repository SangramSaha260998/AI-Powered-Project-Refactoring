import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Injectable } from '@angular/core';
import { environment } from '@env/environment';
import { isObject } from '@app/shared/utilities';
import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';

type IRequestType = 'DELETE' | 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT';
interface IRequestOptions {
  useUrlPrefix?: boolean;
  headers?: any;
  context?: any;
  observe?: 'body' | 'events' | 'response';
  responseType?: 'arraybuffer' | 'blob' | 'json' | 'text';
  reportProgress?: boolean;
}

@Injectable({ providedIn: 'root' })
export class HttpService {
  constructor(private _http: HttpClient) {}

  /**
   * *Service for making backend calls
   *
   * @param method - request method
   * @param url - request url
   * @param params - request params
   * @param options - request extra options
   * @returns observable
   */
  private request(
    method: IRequestType,
    url: string,
    params?: any,
    options?: IRequestOptions,
  ): Observable<any> {
    let data;
    let reqUrl = url;
    let reqOptions: any = { useUrlPrefix: true };

    if (isObject(options)) reqOptions = Object.assign(reqOptions, options);

    // Creating request headers
    if (reqOptions.headers) {
      reqOptions.headers = new HttpHeaders(reqOptions.headers);
    }

    // Assign params
    if (isObject(params)) {
      if (params instanceof FormData) {
        data = params;
        reqOptions.reportProgress = reqOptions.reportProgress || true;
      }
      data = params;
    }

    // Checking url prefix
    if (reqOptions.useUrlPrefix === true) {
      reqUrl = environment.host + '/' + url;
    }

    reqOptions.body = data;
    reqOptions.observe = reqOptions.observe || 'body';

    // Final Request
    const request$: Observable<any> = this._http.request(method, reqUrl, reqOptions);

    request$.pipe(
      map((response: HttpResponse<any>) => {
        const responseObject = response.body;
        return responseObject;
      }),
    );

    return request$;
  }

  /**
   * *HTTP Post request
   *
   * @param url - request url
   * @param params - request params
   * @param options - request extra options
   * @returns observable
   */
  public post(url: string, params: any = {}, options?: IRequestOptions) {
    return this.request('POST', url, params, options);
  }

  /**
   * *HTTP Put request
   *
   * @param url - request url
   * @param params - request params
   * @param options - request extra options
   * @returns observable
   */
  public put(url: string, params: any = {}, options?: IRequestOptions) {
    return this.request('PUT', url, params, options);
  }

  /**
   * *HTTP Patch request
   *
   * @param url - request url
   * @param params - request params
   * @param options - request extra options
   * @returns observable
   */
  public patch(url: string, params: any = {}, options?: IRequestOptions) {
    return this.request('PATCH', url, params, options);
  }

  /**
   * *HTTP Get request
   *
   * @param url - request url
   * @param options - request extra options
   * @returns observable
   */
  public get(url: string, options?: IRequestOptions) {
    return this.request('GET', url, undefined, options);
  }

  /**
   * *HTTP Delete request
   *
   * @param url - request url
   * @param params - request params
   * @param options - request extra options
   * @returns observable
   */
  public delete(url: string, params: any = {}, options?: IRequestOptions) {
    return this.request('DELETE', url, params, options);
  }
}
