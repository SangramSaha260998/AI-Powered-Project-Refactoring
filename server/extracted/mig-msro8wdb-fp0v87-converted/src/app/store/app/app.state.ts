import { inject, Injectable } from '@angular/core';
import { HttpService } from '@app/core/http';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { catchError, tap, throwError } from 'rxjs';
import {
  ProfileDetails,
  EditProfile,
  DeleteProfileImage,
  SetLoginDetails,
  FetchHomeListAsPerRole,
  GetAuditTrailList,
  GetAllEventsList,
  AiReportInfoList,
} from './app.action';
import { ToastrService } from 'ngx-toastr';

interface IAppStateModel {
  apiSuccessMsg: string;
  loginDetails: ILoginDetails | null;
  profileDetails: IProfileDetails | null;
  homeListAsPerRole: IHomeListAsPerRole[];
  auditTrailList: IAuditTrailListResponse[];
  auditTrailCount: number;
  eventList: IFetchAllEventsResponse[];
  mainEventList: IFetchAllEventsResponse[];
  aiReportInfoList: IAiReportInfoList[];
}

@State<IAppStateModel>({
  name: 'app',
  defaults: {
    apiSuccessMsg: '',
    loginDetails: null,
    profileDetails: null,
    homeListAsPerRole: [],
    auditTrailList: [],
    auditTrailCount: 0,
    eventList: [],
    mainEventList: [],
    aiReportInfoList: [],
  },
})
@Injectable()
export class AppState {
  private _http = inject(HttpService);
  private _toastr = inject(ToastrService);

  /* Get api success message */
  @Selector()
  static apiSuccessMsg(state: IAppStateModel) {
    return state.apiSuccessMsg;
  }
  /* Get login details data */
  @Selector()
  static loginDetails(state: IAppStateModel) {
    return state.loginDetails;
  }

  /* Get profile details data */
  @Selector()
  static profileDetails(state: IAppStateModel) {
    return state.profileDetails;
  }
  @Selector()
  static homeListAsPerRole(state: IAppStateModel) {
    return state.homeListAsPerRole;
  }

  /* Get audit trail list data */
  @Selector()
  static auditTrailList(state: IAppStateModel) {
    return state.auditTrailList;
  }

  /* Get audit trail count */
  @Selector()
  static auditTrailCount(state: IAppStateModel) {
    return state.auditTrailCount;
  }

  /* Get event list data */
  @Selector()
  static eventList(state: IAppStateModel) {
    return state.eventList;
  }
  /* Get main event list data */
  @Selector()
  static mainEventList(state: IAppStateModel) {
    return state.mainEventList;
  }

  /* Get ai report info list data */
  @Selector()
  static aiReportInfoList(state: IAppStateModel) {
    return state.aiReportInfoList;
  }

  /* Action login details */
  @Action(SetLoginDetails)
  SetLoginDetails(ctx: StateContext<IAppStateModel>, { payload }: SetLoginDetails) {
    ctx.patchState({
      loginDetails: payload,
    });
  }

  /* Action profile details */
  @Action(ProfileDetails)
  ProfileDetails(ctx: StateContext<IAppStateModel>) {
    return this._http.post('profile/personal-info', {}).pipe(
      tap((apiResult) => {
        const resultData = apiResult.response.dataset;
        ctx.patchState({
          profileDetails: resultData.user_details,
        });
      }),
    );
  }

  @Action(EditProfile)
  EditProfile(
    ctx: StateContext<IAppStateModel>,
    { payload }: EditProfile, // Here, payload is FormData
  ) {
    return this._http.post('admin/editProfile', payload).pipe(
      tap((apiResult) => {
        const loginData = ctx.getState().loginDetails;

        // Extract form data
        const name = payload['first_name'] + ' ' + payload['last_name'];

        // Update with new profile details
        if (loginData) {
          ctx.patchState({
            loginDetails: {
              ...loginData,
              name: name,
            },
            apiSuccessMsg: apiResult.response.status.msg,
          });
        }
      }),
    );
  }

  @Action(DeleteProfileImage)
  DeleteProfileImage(ctx: StateContext<IAppStateModel>) {
    return this._http.post('profile/photo-delete', {}).pipe(
      tap((apiRes) => {
        const profileData = ctx.getState().profileDetails ?? ({} as IProfileDetails);

        // Update state to reflect photo deletion, retaining other details
        ctx.patchState({
          profileDetails: {
            ...profileData,
            photo_url: '', // clear photo_url
          },
          apiSuccessMsg: apiRes.response.status.msg,
        });
      }),
    );
  }

  @Action(FetchHomeListAsPerRole)
  FetchHomeListAsPerRole(ctx: StateContext<IAppStateModel>) {
    return this._http.post('home/homeListPerRole', {}).pipe(
      tap((apiResult) => {
        const response = apiResult.response.data;
        ctx.patchState({
          homeListAsPerRole: response.homeList,
        });
      }),
      catchError((error) => {
        const msg = error?.error?.response?.status?.msg || 'Failed to fetch data';
        this._toastr.error(msg, 'Error', {
          timeOut: 3000,
          closeButton: true,
          tapToDismiss: false,
        });
        return throwError(() => error);
      }),
    );
  }

  /* Action to fetch audit trail list data */
  @Action(GetAuditTrailList)
  GetAuditTrailList(ctx: StateContext<IAppStateModel>, { payload }: GetAuditTrailList) {
    return this._http.post('audit_trail/fetchAll', payload).pipe(
      tap((apiRes) => {
        const response = apiRes.response.data;
        ctx.patchState({
          auditTrailList: response.items,
          auditTrailCount: response.total_count,
        });
      }),
      catchError((error) => {
        const msg = error?.error?.response?.status?.msg || 'Failed to fetch audit trail';
        this._toastr.error(msg, 'Error', {
          timeOut: 3000,
          closeButton: true,
          tapToDismiss: false,
        });
        return throwError(() => error);
      }),
    );
  }

  /* Action to fetch all events data */
  @Action(GetAllEventsList)
  GetAllEventsList(ctx: StateContext<IAppStateModel>, { payload }: GetAllEventsList) {
    return this._http.post('audit_trail/fetchAllEvents', payload).pipe(
      tap((apiRes) => {
        const response = apiRes.response.data;
        if (payload.type === 2) {
          ctx.patchState({
            eventList: response,
          });
        }
        if (payload.type === 1) {
          ctx.patchState({
            mainEventList: response,
          });
        }
      }),
      catchError((error) => {
        const msg = error?.error?.response?.status?.msg || 'Failed to fetch events';
        this._toastr.error(msg, 'Error', {
          timeOut: 3000,
          closeButton: true,
          tapToDismiss: false,
        });
        return throwError(() => error);
      }),
    );
  }

  /* Action to Ai report list info */
  @Action(AiReportInfoList)
  AiReportInfoList(ctx: StateContext<IAppStateModel>) {
    return this._http.get('reports/maserAIReportList').pipe(
      tap((apiRes) => {
        const response = apiRes.response.data;
        ctx.patchState({
          aiReportInfoList: response.masterAIReportList,
        });
      }),
      catchError((error) => {
        const msg = error?.error?.response?.status?.msg || 'Failed to fetch events';
        this._toastr.error(msg, 'Error', {
          timeOut: 3000,
          closeButton: true,
          tapToDismiss: false,
        });
        return throwError(() => error);
      }),
    );
  }
}
