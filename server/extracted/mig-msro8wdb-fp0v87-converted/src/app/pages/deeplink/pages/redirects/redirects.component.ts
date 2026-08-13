import { mergeMap, Subscription } from 'rxjs';
import { appSettings } from '@app/config';
import { ToastrService } from 'ngx-toastr';
import { HttpService } from '@app/core/http';
import { Component, inject, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthenticationService } from '@app/core/authentication';
import { CryptoService, EncryptionService } from '@app/core/services';
import { DeepLinkingRoutesService } from '@app/core/services/deep-linking-routes.service';
import { environment } from '@env/environment';
import { CookieService } from 'ngx-cookie-service';

@Component({
  styleUrl: './redirects.component.scss',
  selector: 'redirects',
  standalone: true,
  imports: [],
  templateUrl: './redirects.component.html'
})
export class RedirectsComponent implements OnDestroy {
  private _encryptService = inject(EncryptionService);
  private credentials: string = appSettings.credentialsKey;
  private subscriptions: Subscription[] = [];
  private deepLinkingShortId: number | string | undefined;
  private _authService = inject(AuthenticationService);

  private isLoggedIn = this._authService.isAuthenticated();

  constructor(
    private _router: Router,
    private _http: HttpService,
    private _route: ActivatedRoute,
    private _toastr: ToastrService,
    private _auth: AuthenticationService,
    private _cookieService: CookieService,
    private _encryptionService: EncryptionService,
    private _cryptoService: CryptoService,
    private _deepLinkingRoutes: DeepLinkingRoutesService,
  ) {
    this.subscriptions.push(
      this._route.params.subscribe(({ deepLinkingShortId }) => {
        if (deepLinkingShortId) {
          sessionStorage.setItem('deepLinkingShortId', deepLinkingShortId);
          this.getDeepLinkingShortId(deepLinkingShortId);
          this._cryptoService.decrypt(deepLinkingShortId);
        }
      }),
    );
  }

  async getDeepLinkingShortId(deepLinkingShortId: string) {
    this.deepLinkingShortId = await this._cryptoService.decrypt(deepLinkingShortId);
    this.redirectionHandler();
  }

  private redirectionHandler() {
    this.subscriptions.push(
      this._http
        .post(
          `${environment.host}/deeplink/getAuthCode`,
          {
            client_id: environment.clientId,
            client_secret: environment.clientSecret,
          },
          {
            useUrlPrefix: false,
          },
        )
        .pipe(
          mergeMap((apiResult1) => {
            const { authorization_code } = apiResult1.response.data;
            return this._http
              .post(
                `${environment.host}/deeplink/getToken`,
                { authorization_code },
                {
                  useUrlPrefix: false,
                },
              )
              .pipe(
                mergeMap((apiResult2) => {
                  const { access_token } = apiResult2.response.data;
                  sessionStorage.setItem('deeplink_token', access_token);
                  return this._http.post(
                    `${environment.host}/deeplink/details`,
                    {
                      short_id: this.deepLinkingShortId?.toString() ?? '',
                    },
                    {
                      useUrlPrefix: false,
                      headers: {
                        Authorization: 'Bearer ' + access_token,
                      },
                    },
                  );
                }),
              );
          }),
        )
        .subscribe({
          next: (apiResult3) => {
            // const data = apiResult3.response.data as IDeepLinkingDetails;
            // this.redirectionDependingOnCondition(data);
            if (apiResult3.response.data.route_identification == 1001) {
              const userName = apiResult3.response.data.route_details.username;
              this._http
                .post('admin/checkPassword', {
                  username: userName
                })
                .subscribe({
                  next: (apiResult4) => {
                    const isPasswordSet = apiResult4.response.data.is_password_set;
                    if (isPasswordSet === 0) {
                      const data = apiResult3.response.data as IDeepLinkingDetails;

                      this.redirectionDependingOnCondition(data);
                    } else {
                      this._toastr.success('Your password is already set', 'success', {
                        closeButton: true,
                        timeOut: 3000
                      });
                      if (!this._cookieService.get('demo_admin_user').length) {
                        this._router.navigate(['/']);
                      } else {
                        this._router.navigate(['/dashboard']);
                      }
                    }
                  },
                  error: (apiError3) => {
                    this._toastr.error(apiError3.error.response.status.msg, 'error', {
                      closeButton: true,
                      timeOut: 3000
                    });
                  }
                });
            } else if (
              apiResult3.response.data.route_identification == 1002 ||
              apiResult3.response.data.route_identification == 1003 ||
              apiResult3.response.data.route_identification == 1004 ||
              apiResult3.response.data.route_identification == 1005 ||
              apiResult3.response.data.route_identification == 1006 ||
              apiResult3.response.data.route_identification == 1010
            ) {
              this._deepLinkingRoutes.redirectToDeepLinkURL(
                apiResult3.response.data.route_identification,
                apiResult3.response.data,
              );
            } else {
              const data = apiResult3.response.data as IDeepLinkingDetails;
              this.redirectionDependingOnCondition(data);
            }
          },
          error: (apiError3) => {
            this._router.navigate(['/']);
            this._toastr.error(apiError3.error.response.status.msg, 'error', {
              closeButton: true,
              timeOut: 3000
            });
          }
        }),
    );
  }

  private redirectionDependingOnCondition(data: IDeepLinkingDetails) {
    if (data.need_to_login) {
      const isAuthenticated = this._auth.isAuthenticated();
      if (isAuthenticated) {
        this._deepLinkingRoutes.createDeepLinkURL(data);
      } else {
        this._router.navigate([
          '/',
          this._encryptionService.encryptUsingAES256(
            encodeURIComponent(String(this.deepLinkingShortId)),
          ),
        ]);
      }
    } else {
      this._deepLinkingRoutes.createDeepLinkURL(data);
    }
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
  }
}
