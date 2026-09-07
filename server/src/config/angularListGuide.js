/**
 * Angular list-page patterns for AI migration.
 * Extracted from the RCA list reference component.
 * Injected into prompts whenever the migration target is Angular.
 */

export const ANGULAR_LIST_GUIDE = `
## ANGULAR LIST PAGE PATTERN (MANDATORY)

Use this for every **list/index** page under
\`pages/<area>/<feature>/pages/<feature>-list/\` or similar.

### Rules
- **NEVER** use plain HTML \`<table>\` — see ANGULAR TABLE MANDATE (injected separately).
- Use \`MatTableModule\` + \`MatTableDataSource\` for the data grid.
- Use \`MatPaginator\` with \`PaginatorDirective\` (\`appPagination\`).
- Filters live in \`global-filter-search\`; \`[(ngModel)]\` is allowed **only**
  on filter controls (not on add/edit forms).
- Persist filter + page state in encrypted \`enc\` query params.
- Reset \`page_no\` to \`1\` whenever filters or global search change.
- Show skeleton loader on first load; show \`no-records-table\` when empty.
- Use \`accessControl\` directive on action columns/buttons.
- Unsubscribe all \`subscriptions\` in \`ngOnDestroy\`.
- Only \`implements OnInit\` / \`OnDestroy\` when those methods exist. Skip both
  for in-memory lists that do not fetch on init.
- Confirmation / delete dialogs opened with \`MatDialog.open()\` must **not** also
  appear as \`<app-task-delete-dialog [task]="deletingTask">\` in the list template.
  If you keep a child tag, that child **class** needs \`@Input()\` / \`@Output()\`
  for every binding — never decorate interface fields.

---

### 1) Component setup (TypeScript)

\`\`\`typescript
import { Component, ElementRef, inject, ViewChild } from '@angular/core';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatAutocompleteModule, MatAutocompleteTrigger } from '@angular/material/autocomplete';
import { MAT_DATE_LOCALE, provideNativeDateAdapter } from '@angular/material/core';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginator, PageEvent } from '@angular/material/paginator';
import { MatSelectModule } from '@angular/material/select';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { ActivatedRoute, Router } from '@angular/router';
import { appSettings } from '@app/config';
import { EncryptionService } from '@app/core/services';
import { BreadcrumbsComponent, ConfirmationDialogComponent, GlobalSearchComponent } from '@app/shared/components';
import { ClickOutsideDirective, PaginatorDirective } from '@app/shared/directives';
import { AccessControlDirective } from '@app/shared/directives/access-control.directive';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';
import { Subscription } from 'rxjs';

@Component({
  selector: 'feature-list',
  standalone: true,
  imports: [
    MatTableModule,
    MatPaginator,
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
    MatAutocompleteModule,
    MatDatepickerModule,
    FormsModule,
    ReactiveFormsModule,
    BreadcrumbsComponent,
    GlobalSearchComponent,
    ClickOutsideDirective,
    PaginatorDirective,
    AccessControlDirective,
    NgxSkeletonLoaderModule,
  ],
  providers: [
    { provide: MAT_DATE_LOCALE, useValue: 'en-GB' },
    provideNativeDateAdapter({
      parse: { dateInput: 'YYYY-MM-DD' },
      display: {
        dateInput: 'YYYY-MM-DD',
        monthYearLabel: 'YYYY-MM-DD',
        dateA11yLabel: 'LL',
        monthYearA11yLabel: 'YYYY-MM-DD',
      },
    }),
  ],
})
export class FeatureListComponent {
  private _store = inject(Store);
  private _router = inject(Router);
  private _dialog = inject(MatDialog);
  private _activatedRoute = inject(ActivatedRoute);
  private _encryptionService = inject(EncryptionService);

  public Math = Math;
  public totalCount = 0;
  public isShowSkeletonLoader = true;
  public isDisabled = false;
  private subscriptions: Subscription[] = [];

  public list: IListItem[] = [];
  public listResponse: IListResponse | null = null;
  public dataSource = new MatTableDataSource<IListItem>();

  public displayedColumns: string[] = [
    'name',
    'homeName',
    'type',
    'status',
    'loggedDate',
    'action',
  ];

  public listPayload: IFetchListParam = {
    action_id: 201,
    page_no: 1,
    rec_per_page: appSettings.rowsPerPage,
    globalFilter: '',
    sortField: 'created_at',
    sortOrder: 1,
    filters: {
      home_id: { value: 0, matchMode: 'equals' },
      type_id: { value: '', matchMode: 'equals' },
      status_id: { value: '', matchMode: 'equals' },
      date_range: { value1: '', value2: '', matchMode: 'dateRange' },
    },
  };

  // Display labels for applied-filter chips
  public filteredPayload = { homeName: '', typeName: '', dateRange: '' };

  // Filter UI state
  public selectedHomeId = 0;
  public selectedHomeName = '';
  public selectedType: { name: string; value: number } | null = null;
  public typeOptions = [
    { name: 'Type A', value: 1 },
    { name: 'Type B', value: 2 },
  ];

  readonly dateRange = new FormGroup({
    start: new FormControl<Date | null>(null),
    end: new FormControl<Date | null>(null),
  });

  @ViewChild(MatPaginator) paginator!: MatPaginator;
  @ViewChild('globalSearchComponentRef') globalSearchComponent!: GlobalSearchComponent;
}
\`\`\`

---

### 2) Fetch list + bind to table

\`\`\`typescript
ngOnInit(): void {
  this.getQueryParams();
  this.fetchList();
}

private fetchList(): void {
  this.subscriptions.push(
    this._store.dispatch(new FetchList(this.listPayload)).subscribe({
      next: () => {
        if (this.isShowSkeletonLoader) {
          this.getListFromStore();
        }
        this.syncFilteredPayloadLabels();
        this.isShowSkeletonLoader = false;
      },
      error: () => { this.isShowSkeletonLoader = false; },
    }),
  );
}

private getListFromStore(): void {
  this.subscriptions.push(
    this.listResponse$.subscribe((res) => {
      if (!res) {
        this.listResponse = null;
        return;
      }
      this.listResponse = res;
      this.list = res.items || [];
      this.totalCount = this.resolveTotalCount(res);
      this.dataSource = new MatTableDataSource<IListItem>(this.list);
    }),
  );
}
\`\`\`

---

### 3) Filter bar (global search + dropdown + date range + home)

\`\`\`html
<div class="global-filter-search">
  <div class="filter-top-block">
    <div class="filter-leftblock">
      <div class="filter-block-together">
        <div class="filter-search-block">
          <global-search
            [searchPlaceholder]="'Search'"
            #globalSearchComponentRef
            (valueChange)="onGlobalSearch($event)" />
        </div>

        <div class="filter-dropdown filter-dropdown-md">
          <mat-form-field appearance="outline" class="custom-select-filter-together">
            <mat-select
              placeholder="Type"
              panelClass="custom-select-panel-filter-together"
              [(ngModel)]="selectedType">
              @for (item of typeOptions; track item.value) {
                <mat-option [value]="item">{{ item.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>

        <div class="date-block">
          <mat-form-field
            class="custom-datepicker filter-custom-daterange"
            [ngClass]="{
              'datepicker-active':
                dateRange.controls['start'].value && dateRange.controls['end'].value,
            }">
            <mat-date-range-input [formGroup]="dateRange" [rangePicker]="picker"
              (click)="picker.open()" (focus)="picker.open()">
              <input matStartDate formControlName="start" placeholder="Start Date" readonly
                (dateChange)="onCustomDateRangeChange()" />
              <input matEndDate formControlName="end" placeholder="End Date" readonly
                (dateChange)="onCustomDateRangeChange()" />
            </mat-date-range-input>
            <mat-datepicker-toggle matIconSuffix [for]="picker"></mat-datepicker-toggle>
            <mat-date-range-picker #picker (closed)="onDateRangePickerClosed()"
              panelClass="custom-filter-calendar"></mat-date-range-picker>
          </mat-form-field>
        </div>

        <div class="filter-dropdown filter-dropdown-last-rounded filter-dropdown-another">
          <input type="text" class="filter-autocomplete-input" matInput placeholder="All Homes"
            (focus)="focusHome()" (clickOutside)="onClickOutsideHome()"
            [(ngModel)]="selectedHomeName" />
          @if (selectHomeShow) {
            <mat-form-field appearance="outline" class="custom-autocomplete-box-filter">
              <input matInput #searchedSelectInput class="autocomplete-input" placeholder="Search"
                [matAutocomplete]="autoSearch" (input)="filterHome()" [(ngModel)]="homeInput"
                #searchTrigger="matAutocompleteTrigger" />
              <mat-autocomplete #autoSearch="matAutocomplete" (optionSelected)="onHomeSelect($event)">
                @for (home of filteredHomes; track home.home_id) {
                  <mat-option [value]="home">{{ home.home_name }}</mat-option>
                }
                @if (filteredHomes.length === 0) {
                  <mat-option disabled>No Records Found</mat-option>
                }
              </mat-autocomplete>
            </mat-form-field>
          }
        </div>

        <button class="btn-search-filter" (click)="onApplyFilters()">Search</button>
      </div>
    </div>
  </div>

  @if (filteredPayload.homeName || filteredPayload.typeName || filteredPayload.dateRange) {
    <div class="filter-bottom-block">
      <div class="filter-applied-block">
        <p>Applied Filters:</p>
        <ul>
          @if (filteredPayload.typeName) {
            <li>
              Type: {{ filteredPayload.typeName }}
              <svg role="none" (click)="onClearIndividualFilter('type_id')">×</svg>
            </li>
          }
          @if (filteredPayload.dateRange) {
            <li>
              Date Range: {{ filteredPayload.dateRange }}
              <svg role="none" (click)="onClearIndividualFilter('date_range')">×</svg>
            </li>
          }
          @if (filteredPayload.homeName) {
            <li>
              Home: {{ filteredPayload.homeName }}
              <svg role="none" (click)="onClearIndividualFilter('home_id')">×</svg>
            </li>
          }
          <li><button class="clear-button" (click)="clearAllFilter()">Clear All</button></li>
        </ul>
      </div>
    </div>
  }
</div>
\`\`\`

**Filter handlers:**

\`\`\`typescript
onGlobalSearch(value: string): void {
  this.listPayload.globalFilter = value;
  this.listPayload.page_no = 1;
  this.createQueryParams();
  this.fetchList();
}

onApplyFilters(): void {
  this.listPayload.filters.home_id.value = this.selectedHomeId || 0;
  this.listPayload.filters.type_id.value = this.selectedType
    ? String(this.selectedType.value) : '';

  const range = this.dateRange.getRawValue();
  if (range.start && range.end) {
    this.listPayload.filters.date_range.value1 = this.formatDateForPayload(range.start);
    this.listPayload.filters.date_range.value2 = this.formatDateForPayload(range.end);
  } else {
    this.listPayload.filters.date_range.value1 = '';
    this.listPayload.filters.date_range.value2 = '';
  }

  this.listPayload.page_no = 1;
  this.createQueryParams();
  this.fetchList();
}

onClearIndividualFilter(field: 'home_id' | 'type_id' | 'date_range'): void {
  // reset the specific filter + UI state, page_no = 1, createQueryParams(), fetchList()
}

clearAllFilter(): void {
  this.globalSearchComponent.setSearchModel('');
  // reset all filters, dateRange, selectedHome, selectedType
  this._router.navigate(['feature-list'], { replaceUrl: true });
  this.fetchList();
}

onDateRangePickerClosed(): void {
  const start = this.dateRange.controls.start.value;
  const end = this.dateRange.controls.end.value;
  if ((start && !end) || (!start && end)) {
    this.dateRange.reset();
  }
}
\`\`\`

---

### 4) Status tabs (All / InProgress / Closed)

\`\`\`html
<div class="table-top-list-wrapper">
  <ul>
    <li class="all-type" [ngClass]="{ active: !listPayload.filters.status_id?.value }">
      <a role="none" (click)="statusFilter('')">
        All <span>{{ listResponse?.total_count }}</span>
      </a>
    </li>
    <li class="inprogress-type"
      [ngClass]="{ active: listPayload.filters.status_id?.value === '12' }">
      <a role="none" (click)="statusFilter(12)">
        InProgress <span>{{ listResponse?.in_progress_count }}</span>
      </a>
    </li>
    <li class="close-type"
      [ngClass]="{ active: listPayload.filters.status_id?.value === '13' }">
      <a role="none" (click)="statusFilter(13)">
        Closed <span>{{ listResponse?.closed_count }}</span>
      </a>
    </li>
  </ul>
</div>
\`\`\`

\`\`\`typescript
statusFilter(status: string | number): void {
  const statusValue = typeof status === 'number' ? String(status) : status;
  if (statusValue === this.listPayload.filters.status_id?.value) return;
  this.listPayload = {
    ...this.listPayload,
    page_no: 1,
    filters: {
      ...this.listPayload.filters,
      status_id: { value: statusValue, matchMode: 'equals' },
    },
  };
  this.createQueryParams();
  this.fetchList();
}
\`\`\`

---

### 5) mat-table + no-records footer + actions

\`\`\`html
<div class="custom-page-wrapper custom-page-wrapper-list">
  <div class="feature-list-table-wrapper">
    <table class="mat-table" mat-table [dataSource]="dataSource"
      [ngClass]="{ 'table-norecords': !dataSource.filteredData.length }">

      <ng-container matColumnDef="name">
        <th mat-header-cell *matHeaderCellDef>
          <div class="custom-datatable-header"><p>Name</p></div>
        </th>
        <td mat-cell *matCellDef="let row">
          <div class="custom-datatable-cont">
            <p [title]="row.name || '--'">{{ row.name || '--' }}</p>
          </div>
        </td>
      </ng-container>

      <ng-container matColumnDef="status">
        <th mat-header-cell *matHeaderCellDef>
          <div class="custom-datatable-header"><p>Status</p></div>
        </th>
        <td mat-cell *matCellDef="let row">
          <div class="custom-datatable-cont">
            <div class="list-status-box"
              [ngClass]="{
                'status-inprogress': row.status === 12,
                'status-close': row.status === 13,
              }">
              <p>{{ row.status === 12 ? 'InProgress' : row.status === 13 ? 'Closed' : 'N/A' }}</p>
            </div>
          </div>
        </td>
      </ng-container>

      <ng-container matColumnDef="action">
        <th mat-header-cell *matHeaderCellDef accessControl [actionIds]="[202, 206]">
          <div class="custom-datatable-header"><p>Actions</p></div>
        </th>
        <td mat-cell *matCellDef="let row">
          <div class="custom-datatable-cont">
            <div class="custom-table-tooltip" accessControl [actionId]="202">
              <a class="list-icon-rounded icon-setting" role="none" (click)="onManage(row)">
                <svg><use xlink:href="/scss/icons.svg#icon-settings-secondary"></use></svg>
              </a>
              <span class="custom-table-tooltip-text">Manage</span>
            </div>
            <div class="custom-table-tooltip" accessControl [actionId]="206">
              <a class="list-icon-rounded icon-delete" role="none"
                (click)="onDelete(row.id)">
                <svg><use xlink:href="/scss/icons.svg#icon-delete"></use></svg>
              </a>
              <span class="custom-table-tooltip-text">Delete</span>
            </div>
          </div>
        </td>
      </ng-container>

      <ng-container matColumnDef="noRecords">
        <mat-footer-cell *matFooterCellDef [attr.colspan]="displayedColumns.length">
          @if (isShowSkeletonLoader) {
            <ngx-skeleton-loader count="5"
              [theme]="{ 'border-radius': '10px', height: '83px', width: '100%' }" />
          } @else {
            <div class="no-records-table">
              <div class="no-records-block">
                <div class="icon-block">
                  <img src="images/mock-list-no-record.svg" width="54" height="65" alt="" />
                </div>
                @if (hasActiveFilters()) {
                  <p>No Records Found</p>
                } @else {
                  <p>No Records Added Yet</p>
                }
              </div>
            </div>
          }
        </mat-footer-cell>
      </ng-container>

      <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
      <tr mat-row *matRowDef="let row; columns: displayedColumns"
        [ngClass]="{
          'status-inprogress': row.status === 12,
          'status-close': row.status === 13,
        }"></tr>
      <mat-footer-row *matFooterRowDef="['noRecords']"
        [hidden]="dataSource.data.length > 0 && dataSource.filteredData.length > 0">
      </mat-footer-row>
    </table>
  </div>
</div>
\`\`\`

**Table rules:**
- Wrap header text in \`.custom-datatable-header\` and cell content in \`.custom-datatable-cont\`.
- Use \`[title]\` on truncated text cells; show \`'--'\` for empty values.
- Use \`@switch\` / \`@if\` for enum display (type, status, form type).
- Row \`ngClass\` can reflect status colour on the whole row.
- Footer row \`noRecords\` shows skeleton while loading, else empty state.

---

### 6) Pagination

\`\`\`html
<div class="paginator-wrapper" [ngClass]="{ '!hidden': !dataSource.filteredData.length }">
  <div class="table-pagination-block" [ngClass]="{ '!hidden': totalCount === 0 }">
    <p>
      Showing
      {{ (listPayload.page_no - 1) * listPayload.rec_per_page + 1 }}
      to
      {{ Math.min(listPayload.page_no * listPayload.rec_per_page, totalCount) }}
      of {{ totalCount }} results
    </p>
  </div>
  <div class="pagination-block"
    [ngClass]="{ '!hidden': totalCount <= listPayload.rec_per_page }">
    <mat-paginator
      appPagination
      [length]="totalCount"
      [pageSize]="listPayload.rec_per_page"
      [pageIndex]="listPayload.page_no - 1"
      [hidePageSize]="true"
      (page)="onPageChange($event)">
    </mat-paginator>
  </div>
</div>
\`\`\`

\`\`\`typescript
onPageChange(event: PageEvent): void {
  this.listPayload = { ...this.listPayload, page_no: event.pageIndex + 1 };
  this.createQueryParams();
  this.fetchList();
}
\`\`\`

---

### 7) Query-param persistence (encrypted filters)

\`\`\`typescript
private getQueryParams(): void {
  this.subscriptions.push(
    this._activatedRoute.queryParams.subscribe((param) => {
      if (!param['enc']) {
        this._router.navigate(['feature-list'], { replaceUrl: true });
        return;
      }
      const decryptData = this._encryptionService.decryptUsingAES256(
        decodeURIComponent(param['enc']),
      );
      if (decryptData?.listPayload) {
        this.restorePayload(decryptData.listPayload);
        setTimeout(() => {
          if (this.globalSearchComponent && decryptData.listPayload.globalFilter) {
            this.globalSearchComponent.setSearchModel(decryptData.listPayload.globalFilter);
          }
        }, 0);
      }
      this.fetchList();
    }),
  );
}

createQueryParams(): void {
  this._router.navigate(['feature-list'], {
    queryParams: {
      enc: encodeURIComponent(
        this._encryptionService.encryptUsingAES256({
          listPayload: this.prepareFilteredParam(),
        }),
      ),
    },
    replaceUrl: true,
  });
}

private prepareFilteredParam() {
  return {
    page_no: this.listPayload.page_no,
    globalFilter: this.listPayload.globalFilter,
    filters: {
      ...this.listPayload.filters,
      selectedHomeName: this.selectedHomeName,
    },
  };
}
\`\`\`

When navigating to detail/edit, pass \`listPayload\` back so the list restores on return:

\`\`\`typescript
this._router.navigate([detailRoute], {
  queryParams: {
    enc: encodeURIComponent(
      this._encryptionService.encryptUsingAES256({
        recordId: row.id,
        listPayload: this.prepareFilteredParam(),
      }),
    ),
  },
});
\`\`\`

---

### 8) Delete with confirmation + pagination fix

\`\`\`typescript
onDelete(recordId: number): void {
  const dialogRef = this._dialog.open(ConfirmationDialogComponent, {
    panelClass: 'custom-warning-dialog',
    backdropClass: 'customDialogBackdrop',
    data: {
      heading: 'Delete Permanently',
      message: 'Are you sure you want to delete this record?',
      dialogType: 'warning',
      showButton: { ok: true, cancel: true },
      buttonText: { ok: 'Yes', cancel: 'No' },
    },
  });
  dialogRef.afterClosed().subscribe((confirmed) => {
    if (!confirmed) return;
    this._store.dispatch(new DeleteRecord({ record_id: recordId })).subscribe({
      next: () => {
        const { page_no, rec_per_page } = this.listPayload;
        const isLastItemOnLastPage =
          page_no * rec_per_page - rec_per_page === this.totalCount - 1;
        if (isLastItemOnLastPage && page_no > 1) {
          this.listPayload.page_no = page_no - 1;
        }
        this.createQueryParams();
        this.fetchList();
      },
    });
  });
}
\`\`\`

---

### 9) List page SCSS

\`\`\`scss
@use 'mixins' as *;
@use '../scss/custom-styles/table.scss' as *;

.table-top-list-wrapper {
  @apply mt-4 mb-2 relative border-b border-b-gray-500 pb-4;
  ul { @include flex-all(flex, center); @apply gap-x-12; }
  li.active::after { @apply w-full; }
}

.list-status-box {
  @apply px-2 py-[3px] rounded inline-block;
  &.status-inprogress { @apply bg-[#FFF0E2]; p { @apply text-[#E47815]; } }
  &.status-close { @apply bg-[#E7F5FD]; p { @apply text-[#0191DA]; } }
}

.feature-list-table-wrapper ::ng-deep {
  .mat-table tbody tr:nth-of-type(odd) { @apply bg-white; }
}
\`\`\`

---

### Checklist before finishing a list component
- [ ] \`listPayload\` with \`page_no\`, \`rec_per_page\`, \`globalFilter\`, \`filters\`
- [ ] \`MatTableDataSource\` + \`displayedColumns\` + \`noRecords\` footer row
- [ ] \`global-filter-search\` bar with Search button (\`onApplyFilters\`)
- [ ] Applied-filter chips with individual clear + Clear All
- [ ] Status tabs with counts (\`table-top-list-wrapper\`)
- [ ] \`mat-paginator\` + \`appPagination\` + "Showing X to Y of Z"
- [ ] Encrypted \`enc\` query params (\`createQueryParams\` / \`getQueryParams\`)
- [ ] Delete via \`ConfirmationDialogComponent\`; fix page when last item deleted
- [ ] \`accessControl\` on action column
- [ ] Skeleton loader on first load; distinct empty messages for filtered vs unfiltered
- [ ] \`ngOnDestroy\` unsubscribes all \`subscriptions\`
`;
