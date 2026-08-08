import { Injectable } from '@angular/core';
import { State, Action, StateContext, Selector } from '@ngxs/store';

export interface IAiReportInfoList {
  master_ai_report_id: number;
  report_main_category: number;
  report_name: string;
  report_description: string;
}

export interface AppStateModel {
  counter: number;
  aiReportInfoList: IAiReportInfoList[];
}

export class AiReportInfoList {
  static readonly type = '[App] Ai Report Info List';
}

@State<AppStateModel>({
  name: 'app',
  defaults: {
    counter: 0,
    aiReportInfoList: []
  }
})
@Injectable()
export class AppState {
  @Selector()
  static getCounter(state: AppStateModel): number {
    return state.counter;
  }

  @Selector()
  static aiReportInfoList(state: AppStateModel): IAiReportInfoList[] {
    return state.aiReportInfoList;
  }

  @Action(AiReportInfoList)
  loadAiReportInfoList(ctx: StateContext<AppStateModel>) {
    // Stub — replace with real API load in the migrated app if needed.
    ctx.patchState({ aiReportInfoList: ctx.getState().aiReportInfoList });
  }
}
