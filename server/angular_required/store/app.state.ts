import { State, Selector } from '@ngxs/store';

export interface AppStateModel {
  counter: number;
}

@State<AppStateModel>({
  name: 'app',
  defaults: {
    counter: 0
  }
})
export class AppState {
  @Selector()
  static getCounter(state: AppStateModel): number {
    return state.counter;
  }
}
