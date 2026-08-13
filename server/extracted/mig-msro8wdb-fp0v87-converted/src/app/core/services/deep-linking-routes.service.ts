import { ActivatedRoute, Router } from '@angular/router';
import { inject, Injectable } from '@angular/core';
import { EncryptionService } from './encryption.service';
import { AuthenticationService } from '../authentication';

@Injectable({
  providedIn: 'root',
})
export class DeepLinkingRoutesService {
  private _activatedRoute = inject(ActivatedRoute);
  private _authService = inject(AuthenticationService);
  private isLoggedIn = this._authService.isAuthenticated();

  private routes: IDeepLinkingDetails[] = [
    {
      user_type: '',
      need_to_login: 1,
      route_identification: 1001,
      route_value: '/create-new-password',
      route_details: {
        email_id: '',
      },
    },
  ];

  constructor(
    private _router: Router,
    private _encryptionService: EncryptionService,
  ) {}

  public createDeepLinkURL(data: IDeepLinkingDetails, redirectionRequired = true) {
    let redirectionDetails = { path: '', fragment: '' };
    const deepLinkDetails = this.routes.find(
      (route) => route.route_identification == data.route_identification,
    );
    if (deepLinkDetails) {
      redirectionDetails = {
        path: deepLinkDetails.route_value,
        fragment: encodeURIComponent(this._encryptionService.encryptUsingAES256(data)),
      };
      if (redirectionRequired)
        this._router.navigate([deepLinkDetails.route_value], {
          fragment: encodeURIComponent(this._encryptionService.encryptUsingAES256(data)),
        });
      return redirectionDetails;
    }
    if (!redirectionRequired) this._router.navigate(['/']);
    return redirectionDetails;
  }

  /**
   * * *This method is used to redirect user to the page where he/she was trying to access through deep linking
   */
  public redirectToDeepLinkURL(routeIdentification: number, routeDetails: any) {
    switch (+routeIdentification) {
      case 1002:
        if (this.isLoggedIn) {
          this._router.navigate(['/ai-daily-report'], {
            queryParams: {
              enc: encodeURIComponent(
                this._encryptionService.encryptUsingAES256({
                  redirec_to: '/ai-daily-report',
                  logged_date: routeDetails.route_details.logged_date,
                }),
              ),
            },
          });
        } else {
          this._router.navigate(['login'], {
            queryParams: {
              enc: encodeURIComponent(
                this._encryptionService.encryptUsingAES256({
                  redirec_to: '/ai-daily-report',
                  logged_date: routeDetails.route_details.logged_date,
                }),
              ),
            },
          });
        }
        break;

      case 1003:
        if (this.isLoggedIn) {
          this._router.navigate(['/audit-planning'], {
            queryParams: {
              enc: encodeURIComponent(
                this._encryptionService.encryptUsingAES256({
                  redirec_to: '/audit-planning',
                  auditId: routeDetails.route_details.event_source_id,
                  homeId: routeDetails.route_details.home_id,
                }),
              ),
            },
          });
        } else {
          this._router.navigate(['login'], {
            queryParams: {
              enc: encodeURIComponent(
                this._encryptionService.encryptUsingAES256({
                  redirec_to: '/audit-planning',
                  auditId: routeDetails.route_details.event_source_id,
                  homeId: routeDetails.route_details.home_id,
                }),
              ),
            },
          });
        }
        break;

      case 1004:
        if (this.isLoggedIn) {
          this._router.navigate(['/external-inspections/add-edit-external-inspections'], {
            queryParams: {
              enc: encodeURIComponent(
                this._encryptionService.encryptUsingAES256({
                  redirec_to: '/external-inspections/add-edit-external-inspections',
                  inspectionId: routeDetails.route_details.event_source_id,
                }),
              ),
            },
          });
        } else {
          this._router.navigate(['login'], {
            queryParams: {
              enc: encodeURIComponent(
                this._encryptionService.encryptUsingAES256({
                  redirec_to: '/external-inspections/add-edit-external-inspections',
                  inspectionId: routeDetails.route_details.event_source_id,
                }),
              ),
            },
          });
        }
        break;

      case 1005:
        if (this.isLoggedIn) {
          this._router.navigate(['/mock-inspection/edit-mock-inspection'], {
            queryParams: {
              enc: encodeURIComponent(
                this._encryptionService.encryptUsingAES256({
                  redirec_to: '/mock-inspection/edit-mock-inspection',
                  mockInspectionId: routeDetails.route_details.event_source_id,
                  homeId: routeDetails.route_details.home_id,
                }),
              ),
            },
          });
        } else {
          this._router.navigate(['login'], {
            queryParams: {
              enc: encodeURIComponent(
                this._encryptionService.encryptUsingAES256({
                  redirec_to: '/mock-inspection/edit-mock-inspection',
                  mockInspectionId: routeDetails.route_details.event_source_id,
                  homeId: routeDetails.route_details.home_id,
                }),
              ),
            },
          });
        }
        break;

      case 1006:
        if (this.isLoggedIn) {
          this._router.navigate(['/action-plan/manage-action'], {
            queryParams: {
              enc: encodeURIComponent(
                this._encryptionService.encryptUsingAES256({
                  redirec_to: '/action-plan/manage-action',
                  actionInfoId: routeDetails.route_details.event_source_id,
                }),
              ),
            },
          });
        } else {
          this._router.navigate(['login'], {
            queryParams: {
              enc: encodeURIComponent(
                this._encryptionService.encryptUsingAES256({
                  redirec_to: '/action-plan/manage-action',
                  actionInfoId: routeDetails.route_details.event_source_id,
                }),
              ),
            },
          });
        }
        break;

      case 1010:
        if (this.isLoggedIn) {
          this._router.navigate(['/feedback/complaint/complaint-management'], {
            queryParams: {
              enc: encodeURIComponent(
                this._encryptionService.encryptUsingAES256({
                  redirec_to: '/feedback/complaint/complaint-management',
                  complaintDetails: routeDetails.route_details.event_source_id,
                }),
              ),
            },
          });
        } else {
          this._router.navigate(['login'], {
            queryParams: {
              enc: encodeURIComponent(
                this._encryptionService.encryptUsingAES256({
                  redirec_to: '/feedback/complaint/complaint-management',
                  complaintDetails: routeDetails.route_details.event_source_id,
                }),
              ),
            },
          });
        }
    }
  }

  /**
   * * *This method is used to redirect user to the page where he/she was trying to access before login through deep linking.
   */
  public loginRedirectionWithRedirection() {
    const subcription = this._activatedRoute.queryParams.subscribe((param) => {
      if (param['enc']) {
        try {
          const decryptData = this._encryptionService.decryptUsingAES256(
            decodeURIComponent(param['enc']),
          );

          if (decryptData && decryptData.redirec_to) {
            const payload: any = {};
            if (decryptData.logged_date) {
              payload.logged_date = decryptData.logged_date;
            } else if (decryptData.complaintDetails) {
              payload.complaintDetails = decryptData.complaintDetails;
            } else if (decryptData.auditId && decryptData.homeId) {
              payload.auditId = decryptData.auditId;
              payload.homeId = decryptData.homeId;
            } else if (decryptData.inspectionId) {
              payload.inspectionId = decryptData.inspectionId;
            } else if (decryptData.mockInspectionId && decryptData.homeId) {
              payload.mockInspectionId = decryptData.mockInspectionId;
              payload.homeId = decryptData.homeId;
            } else if (decryptData.actionInfoId) {
              payload.actionInfoId = decryptData.actionInfoId;
            }
            this._router.navigate([decryptData.redirec_to], {
              queryParams: {
                enc: encodeURIComponent(this._encryptionService.encryptUsingAES256(payload)),
              },
            });
          } else {
            this._router.navigate(['/login']);
          }
        } catch {
          this._router.navigate(['/login']);
        }
      }
    });

    subcription.unsubscribe();
  }
}
