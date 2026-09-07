/**
 * NGXS store patterns for AI migration (Angular target).
 * Extracted from ref store modules (mca_dols, incident-management, app, audit-planning).
 * Injected into prompts whenever the migration target is Angular.
 */

export const ANGULAR_NGXS_GUIDE = `
## NGXS STORE PATTERN (MANDATORY for Angular migrations)

When the source app uses Redux/Context/API hooks for server state, generate **NGXS**
store modules following this project's conventions.

### File structure

\`\`\`
src/app/store/
  index.ts                          # barrel exports all actions + states
  <feature>/
    <feature>.action.ts             # action classes
    <feature>.state.ts              # @State class with selectors + handlers
\`\`\`

Register every new state in \`app.config.ts\`:

\`\`\`typescript
import { provideStore } from '@ngxs/store';
import { withNgxsLoggerPlugin } from '@ngxs/logger-plugin';
import { FeatureState } from './store';

const STATES = [AppState, FeatureState, /* ... */];

export const appConfig: ApplicationConfig = {
  providers: [
    provideStore([...STATES], withNgxsLoggerPlugin({ disabled: environment.production })),
  ],
};
\`\`\`

Export from \`store/index.ts\`:

\`\`\`typescript
export * from './feature/feature.action';
export * from './feature/feature.state';
\`\`\`

---

### 1) Action classes

One class per operation. Use \`static readonly type\` with a bracketed namespace.

\`\`\`typescript
// feature.action.ts

export class FetchFeatureList {
  static readonly type = '[Feature] Fetch List';
  constructor(public payload: IFeatureListPayload) {}
}

export class FetchFeatureDetails {
  static readonly type = '[Feature] Fetch Details';
  constructor(public payload: { record_id: number }) {}
}

export class AddEditFeature {
  static readonly type = '[Feature] Add Edit';
  constructor(
    public payload: IFeatureAddEditPayload,
    public meta: IFeatureAddEditMeta, // display names not returned by API
  ) {}
}

export class DeleteFeature {
  static readonly type = '[Feature] Delete';
  constructor(public payload: { record_id: number }) {}
}

export class ResetFeatureDetails {
  static readonly type = '[Feature] Reset Details';
  // no payload — clears detail state on sidebar close
}

// File upload actions (shared pattern)
export class TempUploads {
  static readonly type = '[TempUploads] Post';
  constructor(public payload: FormData) {}
}

export class DeleteAttachments {
  static readonly type = '[DeleteAttachments] Post';
  constructor(
    public payload: {
      action_id?: number;
      document_id: number | null;
      file_name: string | null;
    },
  ) {}
}
\`\`\`

**Naming rules:**
- Fetch/list: \`Fetch<Feature>List\`, \`Fetch<Feature>Details\`
- CRUD: \`AddEdit<Feature>\`, \`Delete<Feature>\`
- Reset detail on close: \`Reset<Feature>Details\`
- Action \`type\` string: \`'[FeatureName] Verb Noun'\` or \`'[ActionName] Post'\`

---

### 2) State class

\`\`\`typescript
// feature.state.ts
import { inject, Injectable } from '@angular/core';
import { HttpService } from '@app/core/http';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { insertItem, patch, removeItem, updateItem } from '@ngxs/store/operators';
import { ToastrService } from 'ngx-toastr';
import { catchError, tap, throwError } from 'rxjs';
import {
  AddEditFeature,
  DeleteFeature,
  FetchFeatureDetails,
  FetchFeatureList,
  ResetFeatureDetails,
} from './feature.action';

interface IFeatureStateModel {
  list: IFeatureItem[];
  totalRecords: number;
  details: IFeatureDetails | null;
  lookupList: ILookupItem[];
}

@State<IFeatureStateModel>({
  name: 'featureState',          // camelCase state name
  defaults: {
    list: [],
    totalRecords: 0,
    details: null,
    lookupList: [],
  },
})
@Injectable()
export class FeatureState {
  private _http = inject(HttpService);
  private _toastr = inject(ToastrService);

  @Selector()
  static list(state: IFeatureStateModel) {
    return state.list;
  }

  @Selector()
  static totalRecords(state: IFeatureStateModel) {
    return state.totalRecords;
  }

  @Selector()
  static details(state: IFeatureStateModel) {
    return state.details;
  }

  @Selector()
  static lookupList(state: IFeatureStateModel) {
    return state.lookupList;
  }
}
\`\`\`

---

### 3) Action handlers — fetch list

\`\`\`typescript
@Action(FetchFeatureList)
FetchFeatureList(ctx: StateContext<IFeatureStateModel>, { payload }: FetchFeatureList) {
  return this._http.post('feature/list', payload).pipe(
    tap((apiResult) => {
      const response: IFeatureListResponse = apiResult.response.data;
      ctx.patchState({
        list: response.items || [],
        totalRecords: response.total_records || 0,
      });
    }),
    catchError((error) => {
      const msg = error?.error?.response?.status?.msg || 'Failed to fetch list';
      this._toastr.error(msg, 'Error', {
        timeOut: 3000,
        closeButton: true,
        tapToDismiss: false,
      });
      return throwError(() => error);
    }),
  );
}
\`\`\`

**API response shape:** \`apiResult.response.data\` for payload,
\`apiResult.response.status.msg\` for success toast.

---

### 4) Action handlers — fetch details

\`\`\`typescript
@Action(FetchFeatureDetails)
FetchFeatureDetails(ctx: StateContext<IFeatureStateModel>, { payload }: FetchFeatureDetails) {
  return this._http.post('feature/details', payload).pipe(
    tap((apiResult) => {
      const response: IFeatureDetails = apiResult.response.data;
      ctx.patchState({
        details: {
          ...response,
          attachments: response.attachments || [],
          comments: response.comments || [],
        },
      });
    }),
    catchError((error) => {
      const msg = error?.error?.response?.status?.msg || 'Failed to fetch details';
      this._toastr.error(msg, 'Error', { timeOut: 3000, closeButton: true, tapToDismiss: false });
      return throwError(() => error);
    }),
  );
}

@Action(ResetFeatureDetails)
ResetFeatureDetails(ctx: StateContext<IFeatureStateModel>) {
  ctx.patchState({ details: null });
}
\`\`\`

---

### 5) Action handlers — add/edit with list sync

\`\`\`typescript
@Action(AddEditFeature)
AddEditFeature(ctx: StateContext<IFeatureStateModel>, { payload, meta }: AddEditFeature) {
  return this._http.post('feature/addEdit', payload).pipe(
    tap((apiResult) => {
      const response: IFeatureDetails = apiResult.response.data;
      const details: IFeatureDetails = {
        ...response,
        home_name: meta.home_name || response.home_name || '',
        // merge meta display names + preserve nested arrays
        attachments: response.attachments || ctx.getState().details?.attachments || [],
        comments: response.comments || ctx.getState().details?.comments || [],
      };
      ctx.patchState({ details });
      this.patchItemInList(ctx, details, payload.record_id === 0);
      this._toastr.success(apiResult.response.status.msg, 'Success', {
        timeOut: 3000,
        closeButton: true,
        tapToDismiss: false,
      });
    }),
    catchError((error) => {
      const msg = error?.error?.response?.status?.msg || 'Failed to save';
      this._toastr.error(msg, 'Error', { timeOut: 3000, closeButton: true, tapToDismiss: false });
      return throwError(() => error);
    }),
  );
}

private patchItemInList(
  ctx: StateContext<IFeatureStateModel>,
  details: IFeatureDetails,
  isNew: boolean,
) {
  const listItem: IFeatureItem = { /* map details → list row shape */ };

  if (isNew) {
    ctx.setState(
      patch({
        list: insertItem<IFeatureItem>(listItem, 0),
        totalRecords: ctx.getState().totalRecords + 1,
      }),
    );
    return;
  }

  ctx.setState(
    patch({
      list: updateItem<IFeatureItem>(
        (item) => item.record_id === details.record_id,
        patch(listItem),
      ),
    }),
  );
}
\`\`\`

---

### 6) Action handlers — delete with operators

\`\`\`typescript
@Action(DeleteFeature)
DeleteFeature(ctx: StateContext<IFeatureStateModel>, { payload }: DeleteFeature) {
  return this._http.post('feature/delete', payload).pipe(
    tap((apiResult) => {
      const state = ctx.getState();
      ctx.setState(
        patch({
          list: removeItem<IFeatureItem>((item) => item.record_id === payload.record_id),
          totalRecords: Math.max(0, state.totalRecords - 1),
          details:
            state.details?.record_id === payload.record_id ? null : state.details,
        }),
      );
      this._toastr.success(apiResult.response.status.msg, 'Success', {
        timeOut: 3000,
        closeButton: true,
        tapToDismiss: false,
      });
    }),
    catchError((error) => {
      const msg = error?.error?.response?.status?.msg || 'Failed to delete';
      this._toastr.error(msg, 'Error', { timeOut: 3000, closeButton: true, tapToDismiss: false });
      return throwError(() => error);
    }),
  );
}
\`\`\`

Use \`@ngxs/store/operators\`: \`patch\`, \`insertItem\`, \`updateItem\`, \`removeItem\`.

---

### 7) File upload state actions

\`\`\`typescript
@Action(TempUploads)
TempUploads(ctx: StateContext<IFeatureStateModel>, { payload }: TempUploads) {
  return this._http.post('files/tempUploads', payload).pipe(
    tap((apiResult) => {
      ctx.patchState({ attachmentsList: apiResult.response.data.attachments });
    }),
    catchError((error) => {
      const msg = error?.error?.response?.status?.msg || 'Failed to upload file';
      this._toastr.error(msg, 'Error', { timeOut: 3000, closeButton: true, tapToDismiss: false });
      return throwError(() => error);
    }),
  );
}

@Action(DeleteAttachments)
DeleteAttachments(ctx: StateContext<IFeatureStateModel>, { payload }: DeleteAttachments) {
  return this._http.post('files/deleteAttachment', payload).pipe(
    tap(() => {
      if (payload.document_id != null) {
        ctx.setState(
          patch({
            attachmentsList: removeItem<IAttachmentsList>(
              (file) => +file.document_id === +payload.document_id!,
            ),
          }),
        );
      }
    }),
    catchError((error) => {
      const msg = error?.error?.response?.status?.msg || 'Failed to delete attachment';
      this._toastr.error(msg, 'Error', { timeOut: 3000, closeButton: true, tapToDismiss: false });
      return throwError(() => error);
    }),
  );
}
\`\`\`

---

### 8) Component usage — dispatch + select

\`\`\`typescript
import { Store } from '@ngxs/store';
import { take } from 'rxjs';
import { FeatureState, FetchFeatureList, AddEditFeature, ResetFeatureDetails } from '@app/store';

export class FeatureListComponent implements OnInit, OnDestroy {
  private _store = inject(Store);
  private subscriptions: Subscription[] = [];

  private listResponse$ = this._store.select(FeatureState.list);

  ngOnInit(): void {
    this.fetchList();
    this.getListFromStore();
  }

  private fetchList(): void {
    this.subscriptions.push(
      this._store.dispatch(new FetchFeatureList(this.listPayload)).subscribe({
        next: () => { /* store updated in action handler */ },
        error: () => { /* toastr already shown in state */ },
      }),
    );
  }

  private getListFromStore(): void {
    this.subscriptions.push(
      this.listResponse$.subscribe((items) => {
        this.dataSource = new MatTableDataSource(items || []);
      }),
    );
  }

  onSave(): void {
    this.subscriptions.push(
      this._store.dispatch(new AddEditFeature(payload, meta)).subscribe({
        next: () => {
          const details = this._store.selectSnapshot(FeatureState.details);
          if (details?.record_id) {
            this.currentRecordId = details.record_id;
          }
        },
      }),
    );
  }

  onClose(): void {
    this._store.dispatch(new ResetFeatureDetails());
    this.closeSidebar.emit();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((s) => s.unsubscribe());
  }
}
\`\`\`

**Component rules:**
- Only \`implements OnInit\` / \`OnDestroy\` when \`ngOnInit()\` / \`ngOnDestroy()\` exist.
  In-memory UIs with no store fetch or subscriptions must omit both interfaces.
- \`private list$ = this._store.select(FeatureState.selector)\` at class level.
- Always \`dispatch(...).subscribe()\` for API actions (component waits for completion).
- Use \`selectSnapshot(State.selector)\` for one-time read after dispatch success.
- Use \`take(1)\` when reading store once inside a callback.
- Push subscriptions to \`subscriptions[]\`; unsubscribe in \`ngOnDestroy\`.

---

### 9) List response state (with tab counts)

For list pages with status tabs, store the full API response object:

\`\`\`typescript
interface IFeatureStateModel {
  listResponse: IFeatureListResponse | null; // has items, total_count, in_progress_count, closed_count
}

@Selector()
static listResponse(state: IFeatureStateModel) {
  return state.listResponse;
}

@Action(FetchFeatureList)
FetchFeatureList(ctx: StateContext<IFeatureStateModel>, { payload }: FetchFeatureList) {
  return this._http.post('feature/list', payload).pipe(
    tap((apiResult) => {
      ctx.patchState({ listResponse: apiResult.response.data });
    }),
    // ...catchError
  );
}
\`\`\`

Component reads \`listResponse.incidents\`, \`listResponse.total_count\`, etc.

---

### Checklist before finishing a store module
- [ ] \`<feature>.action.ts\` with typed action classes + \`static readonly type\`
- [ ] \`<feature>.state.ts\` with \`@State\`, \`defaults\`, \`@Selector\`, \`@Action\`
- [ ] HTTP via injected \`HttpService\`; never call \`HttpClient\` directly in components
- [ ] Every API action: \`tap\` → \`patchState\` / operators; \`catchError\` → toastr + \`throwError\`
- [ ] Add/edit updates both \`details\` and list via \`insertItem\` / \`updateItem\`
- [ ] Delete uses \`removeItem\` + decrements \`totalRecords\`
- [ ] \`Reset*Details\` action for sidebar/form close
- [ ] Exported from \`store/index.ts\` and registered in \`app.config.ts\` \`STATES\` array
- [ ] Components dispatch actions; components select via \`Store.select\` / \`selectSnapshot\`
`;
