/**
 * Angular reactive-form patterns for AI migration.
 * Extracted from MCA DoLS add/edit (sidebar) and whistleblowing-form (full-page dropdown/textbox).
 * Injected into prompts whenever the migration target is Angular.
 */

export const ANGULAR_FORMS_GUIDE = `
## ANGULAR FORMS — ADD / EDIT SIDEBAR PATTERN (MANDATORY)

Use this pattern for every feature **add/edit** form (usually under
\`pages/<area>/<feature>/components/<feature>-add-edit/\`).

### Rules
- **Reactive Forms only**: \`FormBuilder\`, \`FormGroup\`, \`ReactiveFormsModule\`.
  Never \`[(ngModel)]\` on add/edit forms.
- One main \`FormGroup\` (e.g. \`mcaDolsForm\`, \`taskForm\`) bound with
  \`[formGroup]="..."\` and \`(ngSubmit)="onSave()"\`.
- Standalone \`FormControl\` instances are allowed **only** for Material
  autocomplete display fields that store an object while the real ID lives in
  the main \`FormGroup\`.
- Use \`submitted = false\` until first submit; show errors only after submit.
- Use \`getRawValue()\` on submit so disabled controls are included.
- On close/cancel: emit \`closeSidebar\`, reset form + autocomplete controls,
  set \`submitted = false\`, unsubscribe in \`ngOnDestroy\`.
- Use \`isFormPatching\` flag while patching edit data so \`valueChanges\`
  handlers do not clear dependent fields.
- **File attachments**: use \`FormArray\` in the main \`FormGroup\`; upload only
  after the record is saved (has server ID); use \`DragAndDropFilesDirective\`
  + hidden file input; two-step upload (temp store → link to record).

---

### 1) Component setup (TypeScript)

\`\`\`typescript
import { Component, EventEmitter, inject, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { FormBuilder, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MAT_DATE_LOCALE, provideNativeDateAdapter } from '@angular/material/core';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSidenavModule } from '@angular/material/sidenav';
import { Subscription } from 'rxjs';

@Component({
  selector: 'feature-add-edit',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatInputModule,
    MatFormFieldModule,
    MatDatepickerModule,
    MatAutocompleteModule,
    MatSidenavModule,
  ],
  templateUrl: './feature-add-edit.component.html',
  styleUrl: './feature-add-edit.component.scss',
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
export class FeatureAddEditComponent implements OnInit, OnDestroy {
  private _fb = inject(FormBuilder);

  @Input() recordId = 0;
  @Input() selectedHome: IHomeListAsPerRole | null = null;
  @Output() closeSidebar = new EventEmitter<void>();

  public form!: FormGroup;
  public submitted = false;
  public isDisabled = false;
  private subscriptions: Subscription[] = [];
  private isFormPatching = false;

  // Autocomplete display controls (object in UI, ID in form)
  public lookupControl = new FormControl<ILookup | string>('');
  public lookupList: ILookup[] = [];
  public filteredLookupList: ILookup[] = [];

  // One boolean per datepicker for opened CSS class
  public isPickerOpened = false;

  get formControl() {
    return this.form.controls;
  }

  ngOnInit(): void {
    this.initForm();
    this.bindLookups();
    this.bindFormDependencies();
    if (this.recordId) {
      this.loadDetails(this.recordId);
    }
    if (this.selectedHome) {
      this.patchHome(this.selectedHome);
    }
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((s) => s.unsubscribe());
  }
}
\`\`\`

---

### 2) Form initialization

\`\`\`typescript
private initForm(): void {
  this.form = this._fb.group({
    record_id: [this.recordId || 0],
    fk_home_id: [0, [Validators.required, Validators.min(1)]],
    fk_lookup_id: [0],
    other_text: [{ value: '', disabled: true }, [Validators.maxLength(250)]],
    completed_on: [null as Date | null],
    status_flag: [1, [Validators.required]],
    notes: [''],
  });
}
\`\`\`

- Put validators on the \`FormGroup\` control array: \`[value, [Validators...]]\`.
- Use \`{ value: x, disabled: true }\` for fields enabled only when another
  control changes (see conditional validators below).
- Date fields: \`[null as Date | null]\` — store \`Date\` objects in the form.

---

### 3) Validation & error display

\`\`\`typescript
public hasFormControlError(field: string): boolean {
  const control = this.form.get(field) as FormControl;
  return this.submitted && (control?.errors || control?.invalid);
}
\`\`\`

Template:

\`\`\`html
<div class="form-group" [ngClass]="{ 'invalid-control': hasFormControlError('fk_home_id') }">
  <label for="homeName">Home</label>
  <input id="homeName" class="formcontrol" formControlName="fk_home_id" />
  @if (hasFormControlError('fk_home_id')) {
    <div class="error-message"><p>Home is required</p></div>
  }
</div>
\`\`\`

Submit:

\`\`\`typescript
onSave(): void {
  this.submitted = true;
  if (this.form.invalid) {
    this._helperFn.scrollToInvalidElement(); // or markAllAsTouched()
    return;
  }
  const formData = this.form.getRawValue();
  // build API payload...
}
\`\`\`

**Conditional validators** (enable/disable + validators on valueChanges):

\`\`\`typescript
private bindFormDependencies(): void {
  this.subscriptions.push(
    this.formControl['fk_type_id'].valueChanges.subscribe((typeId) => {
      this.updateOtherFieldsState(+typeId);
    }),
  );
}

private updateOtherFieldsState(typeId: number): void {
  const other = this.formControl['other_text'];
  if (typeId === OTHER_TYPE_ID) {
    other.setValidators([Validators.required, Validators.maxLength(250)]);
    other.enable({ emitEvent: false });
  } else {
    other.clearValidators();
    other.setValidators([Validators.maxLength(250)]);
    other.disable({ emitEvent: false });
    if (!this.isFormPatching) other.setValue('', { emitEvent: false });
  }
  other.updateValueAndValidity({ emitEvent: false });
}
\`\`\`

---

### 4) Patching (edit mode)

\`\`\`typescript
private patchDetails(details: IRecordDetails): void {
  this.isFormPatching = true;
  this.formControl['record_id'].setValue(details.record_id);
  this.formControl['fk_home_id'].setValue(details.home_id);
  this.formControl['completed_on'].setValue(this.parseApiDate(details.completed_on));
  this.formControl['status_flag'].setValue(details.status_flag || 1);
  this.formControl['notes'].setValue(details.notes || '');

  // Sync autocomplete display control from lookup list or API name
  if (+details.lookup_id > 0) {
    this.lookupControl.setValue({
      lookup_id: details.lookup_id,
      lookup_name: details.lookup_name,
    } as ILookup);
    this.formControl['fk_lookup_id'].setValue(details.lookup_id);
  } else {
    this.resetLookup();
  }

  this.updateOtherFieldsState(+details.type_id);
  this.isFormPatching = false;
}

private parseApiDate(value: string | null): Date | null {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

private formatDateForPayload(date: Date | null): string {
  if (!date) return '';
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return \`\${y}-\${m}-\${d}\`;
}
\`\`\`

- After save, re-patch from store/API response so UI stays in sync.
- When home changes in add mode, reset dependent autocomplete + ID fields.

---

### 5) Material autocomplete (lookup field)

**Pattern**: \`lookupControl\` holds the selected **object** for display;
\`fk_lookup_id\` in \`FormGroup\` holds the **numeric ID** sent to the API.

\`\`\`typescript
public displayLookupFn(value: ILookup): string {
  return value?.lookup_name && value.lookup_name !== 'No records found'
    ? value.lookup_name : '';
}

public showFilteredLookup(isFocus: boolean): void {
  const value = this.lookupControl.value;
  const name = typeof value === 'string' ? value : value?.lookup_name;
  this.filteredLookupList =
    name && !isFocus ? this._filterLookups(name) : this.lookupList.slice();
}

public onCloseLookup(): void {
  const value = this.lookupControl.value;
  const index = this.lookupList.findIndex(
    (item) => +item.lookup_id === (typeof value === 'object' ? +value.lookup_id : 0),
  );
  if (index === -1) {
    this.resetLookup();
  } else {
    const item = this.lookupList[index];
    this.lookupControl.setValue(item);
    this.formControl['fk_lookup_id'].setValue(item.lookup_id);
  }
}

public resetLookup(): void {
  this.lookupControl.setValue('');
  this.formControl['fk_lookup_id'].setValue(0);
}

public hasSelectedLookup(): boolean {
  const value = this.lookupControl.value;
  return !!value && typeof value === 'object' && +value.lookup_id > 0;
}
\`\`\`

Template:

\`\`\`html
<mat-form-field appearance="outline" class="custom-autocomplete-box"
  [ngClass]="{ 'no-arrow': hasSelectedLookup() }">
  <input matInput class="autocomplete-input"
    [formControl]="lookupControl"
    [matAutocomplete]="lookupAuto"
    (focus)="showFilteredLookup(true)"
    (input)="showFilteredLookup(false)"
    placeholder="Select item" />
  <mat-autocomplete #lookupAuto="matAutocomplete"
    [displayWith]="displayLookupFn"
    (closed)="onCloseLookup()">
    @for (option of filteredLookupList; track option.lookup_id) {
      <mat-option [value]="option">{{ option.lookup_name }}</mat-option>
    }
  </mat-autocomplete>
  @if (hasSelectedLookup()) {
    <a class="autocomplete-cross" (click)="resetLookup()">×</a>
  }
</mat-form-field>
\`\`\`

---

### 6) Material datepicker

\`\`\`html
<mat-form-field class="custom-datepicker" [class.datepicker-opened]="isPickerOpened">
  <input matInput formControlName="completed_on"
    [matDatepicker]="picker"
    (click)="picker.open()"
    (focus)="picker.open()"
    placeholder="DD/MM/YYYY" />
  <mat-datepicker-toggle matIconSuffix [for]="picker"></mat-datepicker-toggle>
  <mat-datepicker #picker
    (opened)="isPickerOpened = true"
    (closed)="isPickerOpened = false"></mat-datepicker>
</mat-form-field>
\`\`\`

- Use a separate \`isPickerOpenedN\` boolean per date field when there are many.
- Bind \`formControlName\` to a \`Date | null\` control.
- Convert with \`formatDateForPayload()\` before API submit.

---

### 7) Radio buttons (Yes/No numeric values)

Use \`formControlName\` with numeric \`[value]\` (e.g. 1 = Yes, 2 = No).
Wrap in \`.manual-checkbox-radio\` / \`.custom-radio\` for styling.

\`\`\`html
<div class="manual-checkbox-radio">
  <label class="custom-radio">
    <input type="radio" formControlName="has_capacity" [value]="1" />
    <span>Yes</span>
  </label>
  <label class="custom-radio">
    <input type="radio" formControlName="has_capacity" [value]="2" />
    <span>No</span>
  </label>
</div>
\`\`\`

SCSS (minimal):

\`\`\`scss
.manual-checkbox-radio {
  .custom-radio {
    display: inline-flex;
    align-items: center;
    cursor: pointer;
    margin-right: 15px;
  }
  .custom-radio input[type='radio'] {
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    margin-right: 8px;
  }
  .custom-radio input[type='radio']:checked::before {
    content: '';
    width: 10px;
    height: 10px;
    border-radius: 50%;
    transform: scale(1);
  }
}
\`\`\`

---

### 8) Sidebar (parent hosts form; nested sidenav for sub-panels)

**Parent** opens the add/edit component in a sidenav and passes inputs:

\`\`\`html
<mat-sidenav [(opened)]="isAddEditOpen" position="end" class="custom-sidebar">
  <feature-add-edit
    [recordId]="selectedId"
    [selectedHome]="selectedHome"
    (closeSidebar)="onAddEditClose()" />
</mat-sidenav>
\`\`\`

**Child** add/edit form:

\`\`\`typescript
@Output() closeSidebar = new EventEmitter<void>();

onClose(): void {
  this.closeSidebar.emit();
}
\`\`\`

\`\`\`html
<form [formGroup]="form" (ngSubmit)="onSave()">
  <!-- fields -->
  <div class="custom-form-buttons-block">
    <button type="button" class="btn btn-close" (click)="onClose()">Close</button>
    <button type="submit" class="btn btn-secondary" [disabled]="isDisabled">Save</button>
  </div>
</form>
\`\`\`

**Nested sidebar** inside the form (e.g. comments panel) uses a second
\`mat-sidenav-container\` + \`[(opened)]="isNestedSidebarOpen"\`:

\`\`\`html
<mat-sidenav-container [hasBackdrop]="true" fullscreen>
  <mat-sidenav position="end" class="custom-sidebar custom-sidebar-small"
    [(opened)]="isNestedSidebarOpen" [disableClose]="true">
    <section class="sidebar-content-wrapper">
      <header class="sidebar-header">
        <h2>Sub panel title</h2>
        <a class="cross-icon" (click)="onNestedSidebarClose($event)">×</a>
      </header>
      <div class="sidebar-body-wrapper">
        <!-- nested child component -->
      </div>
    </section>
  </mat-sidenav>
</mat-sidenav-container>
\`\`\`

On nested close: set \`isNestedSidebarOpen = false\` and refresh parent data if needed.

---

### 9) File upload (attachments FormArray)

Use a **FormArray** for uploaded files. Upload is disabled until the parent
record is saved (has a server ID). Use \`DragAndDropFilesDirective\` for drag-drop
and a hidden \`<input type="file">\` for browse.

**Imports & setup:**

\`\`\`typescript
import { ElementRef, ViewChild } from '@angular/core';
import { FormArray } from '@angular/forms';
import { DragAndDropFilesDirective, LoadingOverlayDirective } from '@app/shared/directives';

@Component({
  imports: [
    // ...other imports
    DragAndDropFilesDirective,
    LoadingOverlayDirective,
  ],
})
export class FeatureAddEditComponent {
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  public fileSizeError: string | null = null;
  public isShowLoadingOverlay = false;
  public currentRecordId = 0; // set from @Input or after first save

  private readonly MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
  private readonly MAX_FILES = 5;
  public readonly ALLOWED_TYPES = [
    'image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml',
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv', 'text/plain', 'application/rtf',
    'message/rfc822', 'application/vnd.ms-outlook', 'application/octet-stream',
  ];

  get attachments(): FormArray {
    return this.form.get('attachments') as FormArray;
  }

  get acceptTypes(): string {
    return [...this.ALLOWED_TYPES, '.msg'].join(',');
  }

  public isRecordSaved(): boolean {
    return !!this.currentRecordId;
  }
}
\`\`\`

**Form init** — add document type + attachments array:

\`\`\`typescript
private initForm(): void {
  this.form = this._fb.group({
    record_id: [this.recordId || 0],
    // ...other fields
    documentType: [1, [Validators.required]],
    documentTypeOther: [''],
    attachments: this._fb.array([]),
  });
}

// Conditional validator: "Other" document type requires text
this.formControl['documentType'].valueChanges.subscribe((value) => {
  const other = this.formControl['documentTypeOther'];
  if (value === 2) {
    other.setValidators([Validators.maxLength(100)]);
  } else {
    other.clearValidators();
    other.setValue('');
  }
  other.updateValueAndValidity();
});
\`\`\`

**Build attachment FormGroup** (one per file):

\`\`\`typescript
private buildAttachmentGroup(file?: Partial<IAttachment>): FormGroup {
  const fileData = file || {};
  return this._fb.group({
    file_name: [fileData.file_name || ''],
    document_id: [fileData.document_id || ''],
    file_type: [fileData.file_type || ''],
    file_url: [fileData.file_path || fileData.file_url || ''],
    created_at: [fileData.created_at || ''],
    created_by_name: [fileData.created_by_name || ''],
    document_type: [fileData.document_type || this.formControl['documentType'].value],
    document_type_details: [
      fileData.document_type_details || this.formControl['documentTypeOther'].value,
    ],
  });
}
\`\`\`

**Patch attachments in edit mode:**

\`\`\`typescript
const detailAttachments = details.attachments || [];
if (detailAttachments.length) {
  this.attachments.clear();
  detailAttachments.forEach((file) => {
    this.attachments.push(this.buildAttachmentGroup(file));
  });
}
\`\`\`

**Upload guards & disable state:**

\`\`\`typescript
private canUploadFile(): boolean {
  if (!this.currentRecordId) {
    this._toastr.error('Please save the record before uploading attachments');
    return false;
  }
  const selectedDocumentType = this.formControl['documentType'].value;
  const documentTypeOther = this.formControl['documentTypeOther'].value;
  if (!selectedDocumentType) {
    this._toastr.error('Please select a document type before uploading');
    return false;
  }
  if (selectedDocumentType === 2 && !documentTypeOther) {
    this._toastr.error('Please specify other document type before uploading');
    return false;
  }
  return true;
}

isFileUploadDisable(): boolean {
  return (
    !this.currentRecordId ||
    this.isDisabled ||
    this.isShowLoadingOverlay ||
    !this.formControl['documentType'].value
  );
}
\`\`\`

**Upload flow** (validate → FormData → temp upload → link to record):

\`\`\`typescript
onFilesDropped(fileList: FileList | undefined): void {
  if (this.isFileUploadDisable() || !fileList) return;
  this.onUploadAttachments(fileList);
}

openFileBrowser(): void {
  if (!this.canUploadFile()) return;
  this.fileInput.nativeElement.click();
}

onFileChange(event: Event): void {
  const fileList = (event.target as HTMLInputElement).files;
  if (fileList) this.onUploadAttachments(fileList);
}

onUploadAttachments(fileList: FileList): void {
  this.fileSizeError = null;
  if (!this.canUploadFile()) return;
  if (!fileList?.length) { this.resetFileInput(); return; }

  const files = Array.from(fileList);
  const ALLOWED_EXTENSIONS = ['msg'];
  let validFiles = files.filter((file) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    const isValid =
      this.ALLOWED_TYPES.includes(file.type) || ALLOWED_EXTENSIONS.includes(ext || '');
    return isValid && file.size <= this.MAX_FILE_SIZE_BYTES;
  });

  if (files.some((f) => f.size > this.MAX_FILE_SIZE_BYTES)) {
    this.fileSizeError = 'File size must not exceed 20 MB.';
  }
  if (files.length > this.MAX_FILES) {
    this._toastr.warning(\`You can upload a maximum of \${this.MAX_FILES} files.\`);
    this.resetFileInput();
    return;
  }
  if (!validFiles.length) { this.resetFileInput(); return; }

  // Fix .msg MIME type
  validFiles = validFiles.map((file) =>
    file.name.toLowerCase().endsWith('.msg')
      ? new File([file], file.name, { type: 'application/vnd.ms-outlook', lastModified: file.lastModified })
      : file,
  );

  const formData = new FormData();
  validFiles.forEach((file) => formData.append('attachments', file));
  this.isShowLoadingOverlay = true;
  this.isDisabled = true;

  // Step 1: temp upload (store action), then step 2: link to record
  this._store.dispatch(new TempUploads(formData)).subscribe({
    next: () => {
      this.getUploadedFiles();
      this.resetFileInput();
      this.isShowLoadingOverlay = false;
    },
    error: () => {
      this.resetFileInput();
      this.isShowLoadingOverlay = false;
      this.isDisabled = false;
    },
  });
}

private uploadAttachmentsUrl(): void {
  if (!this.uploadedFiles?.length || !this.currentRecordId) {
    this.isDisabled = false;
    return;
  }
  const fileList = this.uploadedFiles.map((item) => ({
    file_name: item.file_name || '',
    file_type: item.file_type || '',
    document_type: this.formControl['documentType'].value || 1,
    document_type_details: this.formControl['documentTypeOther'].value || '',
  }));
  const payload = {
    type_id: ATTACHMENT_TYPE_ID,
    event_id: this.currentRecordId,
    file: fileList,
  };
  this._http.post('files/uploadAttachments', payload).subscribe({
    next: (res) => {
      const uploaded: IAttachment[] = res?.response?.data?.files || [];
      uploaded.forEach((file) => {
        const idx = this.attachments.value.findIndex(
          (item: IAttachment) => item.file_name === file.file_name,
        );
        if (idx > -1) {
          this.attachments.at(idx).patchValue({
            document_id: file.document_id,
            file_url: file.file_url,
            document_type: file.document_type,
            document_type_details: file.document_type_details,
            created_by_name: file.created_by_name,
            created_at: file.created_at,
          });
        } else {
          this.attachments.push(this.buildAttachmentGroup(file));
        }
      });
      this.uploadedFiles = [];
      this.isDisabled = false;
    },
    error: () => { this.isDisabled = false; },
  });
}

private resetFileInput(): void {
  if (this.fileInput?.nativeElement) {
    this.fileInput.nativeElement.value = '';
  }
}
\`\`\`

**Delete & download:**

\`\`\`typescript
onDeleteAttachment(index: number, attachment: { file_name?: string; document_id?: number | string }): void {
  const dialogRef = this._dialog.open(ConfirmationDialogComponent, {
    panelClass: 'custom-warning-dialog',
    backdropClass: 'customDialogBackdrop',
    data: {
      heading: 'Delete from attachments list',
      message: 'Are you sure you want to delete the attachment?',
      dialogType: 'warning',
      showButton: { ok: true, cancel: true },
      buttonText: { ok: 'Yes', cancel: 'No' },
    },
  });
  dialogRef.afterClosed().subscribe((confirmed) => {
    if (!confirmed) return;
    const hasDocumentId = attachment.document_id != null && +attachment.document_id > 0;
    if (!hasDocumentId && !attachment.file_name) {
      this.attachments.removeAt(index);
      return;
    }
    const deletePayload = hasDocumentId
      ? { document_id: +attachment.document_id!, file_name: null }
      : { document_id: null, file_name: attachment.file_name! };
    this._store.dispatch(new DeleteAttachments(deletePayload)).subscribe({
      next: () => this.attachments.removeAt(index),
    });
  });
}

downloadAttachment(file: { file_url?: string; file_name?: string }): void {
  if (file.file_url && file.file_name) {
    this._helperFn.fileDownload(file.file_url, file.file_name);
  }
}
\`\`\`

**After first save** — set \`currentRecordId\` from API response, then upload
any pending files:

\`\`\`typescript
// inside onSave() success handler
if (details?.record_id) {
  this.currentRecordId = details.record_id;
  this.formControl['record_id'].setValue(this.currentRecordId);
  if (this.uploadedFiles.length) {
    this.uploadAttachmentsUrl();
  }
  this.patchDetails(details);
}
\`\`\`

**Template:**

\`\`\`html
<div class="box-block" [loadingOverlay]="isShowLoadingOverlay" [overlayText]="'Please wait...'">
  <h2>Attachments</h2>
  <div class="form-block-row upload-form-block-row">
    <div class="document-type-block"
      [ngClass]="{ 'document-type-block-secondary': formControl['documentType'].value === 2, disable: !isRecordSaved() }">
      <div class="form-group">
        <label>Document Type</label>
        <mat-form-field appearance="outline" class="custom-select">
          <mat-select formControlName="documentType" placeholder="select document type">
            @for (item of docTypes; track item.type_id) {
              <mat-option [value]="item.type_id">{{ item.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </div>
      @if (formControl['documentType'].value === 2) {
        <div class="form-group">
          <input type="text" class="formcontrol" formControlName="documentTypeOther"
            placeholder="Enter Document Type" />
        </div>
      }
    </div>
  </div>

  <div class="form-group custom-upload-area-small"
    [ngClass]="{ disable: isFileUploadDisable() }"
    dragAndDropFiles
    (fileDropped)="onFilesDropped($event)">
    <input type="file" multiple #fileInput [accept]="acceptTypes"
      (change)="onFileChange($event)" [disabled]="isFileUploadDisable()"
      style="display: none" />
    <div class="upload-block">
      <h6>Drag files here to upload</h6>
      <p>Supported: JPG, JPEG, PNG, SVG, PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, RTF, EML, MSG</p>
    </div>
    <button type="button" class="btn btn-primary"
      [disabled]="isFileUploadDisable()" (click)="openFileBrowser()">Browse</button>
    @if (fileSizeError) {
      <div class="error-message error-message-size-exceed"><p>{{ fileSizeError }}</p></div>
    }
  </div>

  <div class="upload-box-wrapper">
    @for (file of attachments.controls; track $index; let fi = $index) {
      <div class="upload-box">
        <span class="about-text">{{ file.value.document_type_details || 'Attachment' }}</span>
        <div class="upload-box-content-area">
          <div class="upload-box-content-left">
            <p role="none" (click)="downloadAttachment(file.value)" [title]="file.value.file_name">
              {{ file.value.file_name }}
            </p>
            @if (file.value.created_by_name || file.value.created_at) {
              <span>
                @if (file.value.created_by_name) { Created by {{ file.value.created_by_name }} }
                @if (file.value.created_at) { {{ file.value.created_at | date: 'dd MMM yyyy' }} }
              </span>
            }
          </div>
          <a role="none" (click)="onDeleteAttachment(fi, file.value)">Delete</a>
        </div>
      </div>
    }
  </div>
</div>
\`\`\`

**SCSS** (component-level list styles; base upload area is in \`form.scss\`):

\`\`\`scss
.upload-box-wrapper {
  @apply grid grid-cols-2 gap-x-[30px] gap-y-5;
}
.upload-box {
  @apply border border-gray-300 bg-white py-[17px] pr-5 pl-4 relative;
  .about-text {
    @apply absolute -top-2.5 left-5 text-xxs text-primary bg-white px-2;
  }
}
.upload-box-content-area {
  @include flex-all(flex, center, space-between);
  p { @apply cursor-pointer text-secondary; }
}
\`\`\`

**Key rules:**
- Use \`FormArray\` — never store file objects directly in \`FormGroup\` controls.
- Upload only after record has a server ID (\`currentRecordId > 0\`).
- Two-step upload: \`TempUploads(formData)\` then \`files/uploadAttachments\` API.
- Validate file type (MIME + extension), size (20 MB), and count (max 5).
- Use \`[loadingOverlay]\` during upload; disable form with \`isDisabled\`.
- Reset hidden file input after each upload attempt (\`resetFileInput()\`).
- Delete requires confirmation dialog; use \`document_id\` when available.

---

### 10) Form wrapper HTML classes

\`\`\`html
<form [formGroup]="form" (ngSubmit)="onSave()">
  <div class="custom-form-block">
    <div class="form-group" [ngClass]="{ 'invalid-control': hasFormControlError('field') }">
      <!-- label + control + @if error -->
    </div>
  </div>
  <div class="custom-form-buttons-block flex items-center">
    <button type="button" class="btn btn-close" (click)="onClose()">Close</button>
    <button type="submit" class="btn btn-secondary" [disabled]="isDisabled">Save</button>
  </div>
</form>
\`\`\`

---

## FULL-PAGE FORM — mat-select DROPDOWN & TEXTBOX (MANDATORY)

Use this for **full-page** feature forms (e.g. reports, complaints, whistleblowing)
under \`pages/<area>/<feature>/components/<feature>-form/\`.

**Do NOT implement auto-save** — no \`onFieldBlur\` save triggers, no debounced
\`autoSaveTrigger$\`, no \`lastSavedFieldValues\`. Use manual submit only.

### Page layout

\`\`\`html
<form [formGroup]="form" (ngSubmit)="onSubmit()">
  <div class="management-content-right-area">
    <header><h2>Form title</h2></header>
    <div class="right-area-form-block">
      <div class="form-block-row">
        <!-- form-group fields (3-column grid) -->
      </div>
    </div>
    <div class="form-buttons-block">
      <button type="submit" class="btn btn-secondary" [disabled]="isDisabled">Save</button>
    </div>
  </div>
</form>
\`\`\`

SCSS:

\`\`\`scss
.management-content-right-area {
  @apply bg-white border border-disabled pb-10 pt-6;
  @include rounded(14);
  header h2 {
    @apply text-1xl font-secondary font-light text-secondary border-b border-gray-300 pb-7;
  }
}
.right-area-form-block { @apply px-5; }
.form-block-row { @apply grid grid-cols-3 gap-x-7 items-end; }
.form-group label { @apply normal-case; }
\`\`\`

---

### 11) mat-select dropdown (normal dropdown)

**Imports:** add \`MatSelectModule\` to component \`imports\`.

**Form init** — dropdowns store numeric IDs; \`0\` means unselected:

\`\`\`typescript
import { MatSelectModule } from '@angular/material/select';

this.form = this._fb.group({
  type: new FormControl(0),
  howWasReceived: new FormControl(0),
  levelOfSeverity: new FormControl(0),
  documentType: new FormControl<number>(1, [Validators.required]),
  // text fields alongside dropdowns
  otherReceivedMode: new FormControl('', [Validators.maxLength(255)]),
});
\`\`\`

**Template** — always use \`custom-select\` + \`custom-select-panel\`:

\`\`\`html
<div class="form-group">
  <label>How was this received</label>
  <mat-form-field appearance="outline" class="custom-select">
    <mat-select
      placeholder="Select"
      panelClass="custom-select-panel"
      formControlName="howWasReceived">
      @for (mode of receivedModeList; track mode.complaint_received_type_id) {
        @if (
          mode.status ||
          form.get('howWasReceived')?.value === mode.complaint_received_type_id
        ) {
          <mat-option
            [value]="+mode.complaint_received_type_id"
            [disabled]="!mode.status">
            {{ mode.complaint_received_type_name }}
          </mat-option>
        }
      }
    </mat-select>
  </mat-form-field>
</div>
\`\`\`

**Dropdown rules:**
- Always bind \`[value]="+id"\` (numeric) on \`mat-option\`.
- Show inactive options only when they are the current value (edit mode).
- Use \`[disabled]="!item.status"\` for inactive list items.
- Static lists (e.g. type status) use the same pattern with \`@for (item of typeStatus; track item.value)\`.

---

### 12) Textbox input (normal text field)

\`\`\`html
<div class="form-group" [ngClass]="{ 'invalid-control': hasFormControlError('contactDetails') }">
  <label for="contactDetails">Contact Details (If provided)</label>
  <input
    type="text"
    id="contactDetails"
    maxlength="255"
    class="formcontrol"
    autocompleteOff="off"
    formControlName="contactDetails"
    placeholder="Enter Contact Details" />
  @if (hasFormControlError('contactDetails')) {
    @if (formControl['contactDetails'].hasError('maxlength')) {
      <div class="error-message error-line-message">
        <p>Contact details must be 255 characters or less</p>
      </div>
    }
    @if (formControl['contactDetails'].hasError('required')) {
      <div class="error-message">
        <p>Please enter contact details</p>
      </div>
    }
  }
</div>
\`\`\`

**Textbox rules:**
- Use native \`<input class="formcontrol">\` — not \`matInput\` for plain text fields.
- Set \`autocompleteOff="off"\` and \`maxlength\` matching validator.
- Put \`invalid-control\` on the \`.form-group\` wrapper, not the input.
- Use \`error-line-message\` class for maxlength errors that need more width.
- Optional fields: only \`Validators.maxLength(n)\`; required fields add \`Validators.required\`.

---

### 13) Dropdown + "Other" textbox pair

When a dropdown has an **Other** option, pair it with a conditional text field.

**TypeScript** — \`setupOtherFieldValidation()\`:

\`\`\`typescript
private setupReceivedModeOtherValidation(): void {
  const parentControl = this.form.get('howWasReceived') as FormControl<number | null>;
  const otherControl = this.form.get('otherReceivedMode') as FormControl<string | null>;
  const OTHER_ID = 5;

  const applyValidator = (value: number | null) => {
    if (value === OTHER_ID) {
      otherControl.setValidators([Validators.required, Validators.maxLength(255)]);
    } else {
      otherControl.setValidators([Validators.maxLength(255)]);
      otherControl.setValue('');
    }
    otherControl.updateValueAndValidity();
  };

  applyValidator(parentControl.value);
  this.subscriptions.push(
    parentControl.valueChanges.subscribe((value) => applyValidator(value)),
  );
}
\`\`\`

Call \`setup*OtherValidation()\` from \`initForm()\` for every dropdown/other pair
(e.g. \`documentType\`/\`documentTypeOther\`, \`category\`/\`otherCategory\`).

**Template** — show \`*\` on label; disable styling when parent is not Other:

\`\`\`html
<div class="form-group" [ngClass]="{ 'invalid-control': hasFormControlError('otherReceivedMode') }">
  <label for="received_mode">
    Other Received Mode
    @if (formControl['howWasReceived'].value === 5) {
      <sup>*</sup>
    }
  </label>
  <input
    type="text"
    id="received_mode"
    class="formcontrol"
    [ngClass]="formControl['howWasReceived'].value === 5 ? '' : 'disabled'"
    autocompleteOff="off"
    formControlName="otherReceivedMode"
    placeholder="Enter received mode" />
  @if (hasFormControlError('otherReceivedMode')) {
    @if (formControl['otherReceivedMode'].hasError('required')) {
      <div class="error-message"><p>Please enter other received mode</p></div>
    }
    @if (formControl['otherReceivedMode'].hasError('maxlength')) {
      <div class="error-message error-line-message">
        <p>Received mode must be 255 characters or less</p>
      </div>
    }
  }
</div>
\`\`\`

---

### 14) Manual submit only (no auto-save)

\`\`\`typescript
public submitted = false;

public hasFormControlError(field: string): boolean {
  const control = this.form.get(field) as FormControl;
  return this.submitted && (control?.errors || control?.invalid);
}

onSubmit(): void {
  this.submitted = true;
  if (this.form.invalid) {
    this.form.markAllAsTouched();
    this._helperFn.scrollToInvalidElement();
    return;
  }
  this.isDisabled = true;
  const formData = this.form.getRawValue();
  // build payload and call API...
}
\`\`\`

**Never generate:**
- \`onFieldBlur()\` that triggers save
- \`autoSaveTrigger$\`, \`setupAutoSaveDebounce()\`, \`lastSavedFieldValues\`
- \`save_type: 1\` auto-save payloads
- Debounced \`valueChanges\` that POST to API

---

### Checklist before finishing a form component
- [ ] \`initForm()\`, \`bindFormDependencies()\`, \`hasFormControlError()\`, \`onSave()\` / \`onSubmit()\`, \`onClose()\`
- [ ] Edit mode: \`patchDetails()\` + \`parseApiDate()\` / \`formatDateForPayload()\`
- [ ] Autocomplete: display \`FormControl\` + hidden ID in \`FormGroup\` + \`displayWith\` + reset
- [ ] Datepicker: \`provideNativeDateAdapter\` + \`MatDatepickerModule\`
- [ ] Radio: \`formControlName\` + numeric \`[value]\`
- [ ] Dropdown: \`mat-select\` + \`custom-select\` + numeric \`[value]="+id"\` + inactive-option rule
- [ ] Textbox: \`input.formcontrol\` + \`invalid-control\` on \`.form-group\` + maxlength/required errors
- [ ] Other field: \`setup*OtherValidation()\` + conditional \`sup *\` + \`disabled\` class
- [ ] File upload: \`FormArray\` attachments + \`DragAndDropFilesDirective\` + two-step upload + delete confirm
- [ ] No auto-save on blur or debounced \`valueChanges\`
- [ ] \`ngOnDestroy\` unsubscribes all \`subscriptions\`
- [ ] No \`ngModel\` on add/edit fields
`;
