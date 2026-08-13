import { Action, Selector, State, StateContext } from '@ngxs/store';
import { inject, Injectable } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { HttpService } from '@app/core/http';
import { catchError, finalize, tap, throwError } from 'rxjs';
import { FetchDrillDownDetails } from './dashboard.action';

interface IDashboardStateModel {
  drillDownAssigneeList: IDrillDownDetailsAssigneeItem[];
  drillDownDetailsTotalCount: number;
  drillDownDetailsLoading: boolean;
  drillDownDetailsPayload: IDrillDownDetailsPayload | null;
}

@State<IDashboardStateModel>({
  name: 'dashboardState',
  defaults: {
    drillDownAssigneeList: [],
    drillDownDetailsTotalCount: 0,
    drillDownDetailsLoading: false,
    drillDownDetailsPayload: null,
  },
})
@Injectable()
export class DashboardState {
  private _http = inject(HttpService);
  private _toastr = inject(ToastrService);

  @Selector()
  static drillDownAssigneeList(state: IDashboardStateModel) {
    return state.drillDownAssigneeList;
  }

  @Selector()
  static drillDownDetailsTotalCount(state: IDashboardStateModel) {
    return state.drillDownDetailsTotalCount;
  }

  @Selector()
  static drillDownDetailsLoading(state: IDashboardStateModel) {
    return state.drillDownDetailsLoading;
  }

  @Selector()
  static drillDownDetailsPayload(state: IDashboardStateModel) {
    return state.drillDownDetailsPayload;
  }

  @Action(FetchDrillDownDetails, { cancelUncompleted: true })
  fetchDrillDownDetails(
    ctx: StateContext<IDashboardStateModel>,
    { param, showLoader }: FetchDrillDownDetails,
  ) {
    if (showLoader) {
      ctx.patchState({
        drillDownDetailsLoading: true,
        drillDownDetailsPayload: param,
        drillDownAssigneeList: [],
        drillDownDetailsTotalCount: 0,
      });
    } else {
      ctx.patchState({
        drillDownDetailsPayload: param,
      });
    }

    return this._http.post('reports/drillDownDetails', param).pipe(
      tap((apiResult) => {
        const response = (apiResult?.response?.data ?? {}) as IDrillDownDetailsResponse;
        ctx.patchState({
          drillDownAssigneeList: response.assigneeList ?? [],
          drillDownDetailsTotalCount: response.total_count ?? 0,
        });
      }),
      catchError((error) => {
        ctx.patchState({
          drillDownAssigneeList: [],
          drillDownDetailsTotalCount: 0,
        });
        const msg = error?.error?.response?.status?.msg || 'Failed to fetch drill down details';
        this._toastr.error(msg, 'Error', {
          timeOut: 3000,
          closeButton: true,
          tapToDismiss: false,
        });
        return throwError(() => error);
      }),
      finalize(() => {
        if (showLoader) {
          ctx.patchState({
            drillDownDetailsLoading: false,
          });
        }
      }),
    );
  }
}
