import { of } from 'rxjs';
import { HttpService } from '../http';
import { appSettings } from '../../config';
import { Injectable } from '@angular/core';
import { EncryptionService } from '../services';
import { Observable, mergeMap, tap } from 'rxjs';
import { CookieService } from 'ngx-cookie-service';
import { browserInfo } from '../../shared/utilities';
import { CommonService } from '../services/common.service';

@Injectable({ providedIn: 'root' })
export class AuthenticationService {
  private credentials: string = appSettings.credentialsKey;

  constructor(
    private _http: HttpService,
    private _commonService: CommonService,
    private _cookieService: CookieService,
    private _encryptionService: EncryptionService,
  ) {}

  /**
   * *Login user
   *
   * @param data login data
   * @param remember_me remember me
   * @returns observable of boolean
   */
  public authenticate(data: ILoginData, remember_me: boolean) {
    const loginParam: IAuthParam = {
      ...data,
      login_type: 1, //1=>Normal Login, 2=>Social Login
      session_id: browserInfo().session_id,
      browser_id: browserInfo().browser_id,
      browser_name: browserInfo().browser_name,
      browser_version: browserInfo().browser_version,
      social_id: '',
      social_token: '',
      social_type: '',
    };

    return this._http.post('admin/login', loginParam).pipe(
      mergeMap((result1) => {
        const authCodeObj: IAuthCodeInfo = result1.response.data;
        return this._http
          .post('admin/generateToken', {
            authorization_code: authCodeObj.authorization_code,
          })
          .pipe(
            tap((result) => {
              const authResponse: ITokenInfo = {
                ...result.response.data,
                enc_email: this._encryptionService.encryptUsingAES256(loginParam.username),
              };
              this._cookieService.deleteAll();
              // set cookie for remember me
              if (remember_me) {
                const rememberMe = {
                  username: data.username,
                  password: data.password,
                };
                this._cookieService.set(
                  appSettings.rememberKey,
                  this._encryptionService.encryptUsingAES256(rememberMe),
                  {
                    path: '/',
                  },
                );
              }
              // set cookie for tokens
              this._cookieService.set(this.credentials, JSON.stringify({ ...authResponse }), {
                path: '/',
              });
              // take token backup
              this._commonService.saveTokenInfo(JSON.stringify(authResponse));
              return authResponse;
            }),
          );
      }),
    );
  }

  /**
   * *Reset user password
   *
   * @param param reset password param
   * @returns observable
   */
  public resetPassword(param: ICreatePasswordParam) {
    return this._http.post('admin/createPassword', param);
  }

  /**
   * *getting user from storage
   *
   * @returns current user's data
   */
  public getUser(): ITokenInfo {
    const user = this._cookieService.get(this.credentials) as string;
    const savedCredentials: ITokenInfo = user ? JSON.parse(user) : null;
    // take token backup
    if (user) this._commonService.saveTokenInfo(user);
    return savedCredentials;
  }

  /**
   * *Returning current user detail from storage
   *
   * @returns observable of current user
   * @developer
   */
  public getUserInfo(): Observable<ITokenInfo> {
    const savedCredentials: ITokenInfo = this.getUser();
    return of(savedCredentials);
  }

  /**
   * *Getting current user token from cookie
   *
   * @returns JWT Token
   */
  public getToken(): string {
    const savedCredentials = this.getUser();
    return savedCredentials && savedCredentials.access_token ? savedCredentials.access_token : '';
  }

  /**
   * *Sign outs user
   * *Removes details from the token storage
   *
   * @returns observable of boolean
   */
  public logout() {
    this._cookieService.delete(this.credentials);
    this._cookieService.delete(this.credentials, '/');
  }

  /**
   * *If user is authenticated
   *
   * @returns boolean if authenticated
   */
  public isAuthenticated() {
    if (this._cookieService.get(this.credentials)) {
      return true;
    }
    return false;
  }

  /**
   * *Generate new token
   *
   * @returns refresh token
   */
  public getRefreshToken() {
    const userInfo = this.getUser();
    const param = {
      refresh_token: userInfo.refresh_token,
    };
    return this._http.post('admin/regenerateToken', param);
  }

  /**
   * *Updating new tokens in cookie
   *
   * @param authData refresh auth result
   */
  public updateRefreshedToken(authData: Omit<ITokenInfo, 'enc_email'>) {
    const savedCredentials: ITokenInfo = this.getUser();
    const updated = {
      ...savedCredentials,
      ...authData,
    };
    this._cookieService.set(this.credentials, JSON.stringify(updated), {
      path: '/',
    });
    // take token backup
    this._commonService.saveTokenInfo(JSON.stringify(updated));
  }

  /**
   * *Forgetting password
   *
   * @returns observable
   */
  public forgetPassword(username: string) {
    const param = {
      username: username,
    };
    return this._http.post('admin/forgotPassword', param);
  }

  /**
   * *Verifying otp
   *
   * @returns observable
   */
  public verifyOtp(payload: IVerifyOtpPayload) {
    return this._http.post('admin/verifyOtp', payload);
  }
  public loginDetails() {
    return this._http.post('admin/loginDetails', {});
  }
}
