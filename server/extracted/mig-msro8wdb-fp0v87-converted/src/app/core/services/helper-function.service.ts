import moment from 'moment';
import { Moment } from 'moment';
import { catchError, map, of, Subscription } from 'rxjs';
import { ActivatedRoute, Router } from '@angular/router';
import { EncryptionService } from './encryption.service';
import { inject, Injectable, OnDestroy } from '@angular/core';
import { MatDatepickerInputEvent } from '@angular/material/datepicker';
import { FormGroup, FormArray, ValidatorFn, AbstractControl } from '@angular/forms';
import { ToastrService } from 'ngx-toastr';
import { HttpService } from '../http';
import { CommonService } from './common.service';

@Injectable({
  providedIn: 'root',
})
export class HelperFunctionService implements OnDestroy {
  private _router = inject(Router);
  private _route = inject(ActivatedRoute);
  private _toastr = inject(ToastrService);
  private _httpService = inject(HttpService);
  private _commonService = inject(CommonService);
  private _encryptionService = inject(EncryptionService);
  public today = new Date();
  public nextDay = new Date();
  public yesterday = new Date();
  public previousMonthFirstDate = new Date();
  public currentMonthLastDate = new Date();
  public currentYearFirstDate = new Date();
  public currentYearLastDate = new Date();
  private subscriptions: Subscription[] = [];

  constructor() {
    this.setDateVariableData();
  }

  private setDateVariableData() {
    this.yesterday.setDate(new Date().getDate() - 1);
    this.nextDay.setDate(new Date().getDate() + 1);
    this.currentMonthLastDate = new Date(this.today.getFullYear(), this.today.getMonth() + 1, 0);
    // Subtract one month
    this.previousMonthFirstDate.setMonth(this.previousMonthFirstDate.getMonth() - 1);
    // Set the day to the first day of the month
    this.previousMonthFirstDate.setDate(1);
    this.currentYearFirstDate = new Date(this.today.getFullYear(), 0, 1);
    this.currentYearLastDate = new Date(this.today.getFullYear(), 11, 31);
  }

  public formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const d = date.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  public getLastNDaysDateRange(days: number) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days);
    return {
      start,
      end,
      startDateString: this.formatDate(start),
      endDateString: this.formatDate(end),
    };
  }

  /**
   * Returns the current month's boundary dates and API-formatted strings.
   */
  public getCurrentMonthDateRange(): {
    start: Date;
    end: Date;
    startDateString: string;
    endDateString: string;
  } {
    const start = new Date(this.today.getFullYear(), this.today.getMonth(), 1);
    const end = new Date(this.today.getFullYear(), this.today.getMonth() + 1, 0);
    return {
      start,
      end,
      startDateString: this.formatDateToApi(start),
      endDateString: this.formatDateToApi(end),
    };
  }

  /**
   * Format a Date object as YYYY-MM-DD for API payloads.
   */
  public formatDateToApi(date: Date): string {
    const y = date.getFullYear();
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const d = date.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * Returns true when the supplied range matches the current month.
   */
  public isDateRangeEqualToCurrentMonth(start: Date | null, end: Date | null): boolean {
    if (!start || !end) {
      return false;
    }

    const currentRange = this.getCurrentMonthDateRange();
    return (
      this.formatDateToApi(start) === currentRange.startDateString &&
      this.formatDateToApi(end) === currentRange.endDateString
    );
  }

  /**
   * Returns true when the supplied range matches with the last 90 days.
   */
  public isDateRangeEqualToLast90Days(start: Date | null, end: Date | null): boolean {
    if (!start || !end) {
      return false;
    }
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(endDate.getDate() - 89);
    return (
      this.formatDateToApi(start) === this.formatDateToApi(startDate) &&
      this.formatDateToApi(end) === this.formatDateToApi(endDate)
    );
  }

  /**
   * *Remove / Set all Form Validators
   *
   * @param form
   * @param validators
   * @developer Abhisek Dhua
   */
  public setOrRemoveValidators(form: FormGroup, validators: ValidatorFn[] | null) {
    for (const key in form.controls) {
      const control = form.controls[key];

      if (control instanceof FormGroup) {
        this.setOrRemoveValidators(control, validators);
      } else if (control instanceof FormArray) {
        for (let i = 0; i < control.length; i++) {
          const formArrayControl = control.at(i);
          if (formArrayControl instanceof FormGroup) {
            this.setOrRemoveValidators(formArrayControl, validators);
          } else {
            formArrayControl.clearValidators();
            formArrayControl.setValidators(validators);
            formArrayControl.updateValueAndValidity();
          }
        }
      } else {
        control.clearValidators();
        control.setValidators(validators);
        control.updateValueAndValidity();
      }
    }
  }

  /**
   * *Update Value and Validators
   *
   * @param form
   * @developer Abhisek Dhua
   */
  public updateFormValueAndValidity(form: FormGroup) {
    for (const key in form.controls) {
      const control = form.controls[key];

      if (control instanceof FormGroup) {
        this.updateFormValueAndValidity(control);
      } else if (control instanceof FormArray) {
        for (let i = 0; i < control.length; i++) {
          const formArrayControl = control.at(i);
          if (formArrayControl instanceof FormGroup) {
            this.updateFormValueAndValidity(formArrayControl);
          } else {
            formArrayControl.updateValueAndValidity();
          }
        }
      } else {
        control.updateValueAndValidity();
      }
    }
  }

  /**
   * Decrypt Form Fields
   *
   * @param inputObj encrypted obj
   * @returns decrypt object
   * @developer Abhisek Dhua
   */
  public decryptFormFields(inputObj: any) {
    const decryptedObject: any = {};
    for (const [key, value] of Object.entries(inputObj)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) && // not array
        !(
          value instanceof Date ||
          value instanceof File ||
          moment.isMoment(value) ||
          value instanceof FileList
        ) // not Date/File/fileList/Moment Object
      ) {
        decryptedObject[this._encryptionService.decryptUsingAES256(key)] =
          this.decryptFormFields(value);
      } else if (Array.isArray(value) && value.length > 0) {
        decryptedObject[this._encryptionService.decryptUsingAES256(key)] = [];
        for (let i = 0; i < value.length; i++) {
          const el = value[i];
          if (el !== null && typeof el === 'object') {
            decryptedObject[this._encryptionService.decryptUsingAES256(key)][i] =
              this.decryptFormFields(el);
          } else {
            decryptedObject[this._encryptionService.decryptUsingAES256(key)][i] = el;
          }
        }
      } else {
        decryptedObject[this._encryptionService.decryptUsingAES256(key)] = value;
      }
    }
    return decryptedObject;
  }

  /**
   * *Scroll Down to Specific Selector
   *
   * @param selector target
   * @developer Abhisek Dhua
   */
  public scrollToInvalidElement(selector?: string, type: 'all' | 'specific' = 'all') {
    setTimeout(() => {
      if (type === 'all') {
        const element = document.querySelectorAll(selector ? selector : '.invalid-control');
        if (element && element.length)
          element[0].scrollIntoView({
            block: 'center',
            // inline: 'center',
            behavior: 'smooth',
          });
      } else {
        const element = document.querySelector(selector ? selector : '.ng-invalid');
        if (element)
          element.scrollIntoView({
            block: 'center',
            inline: 'center',
            behavior: 'smooth',
          });
      }
    }, 0);
  }

  /**
   * Download file from url using JS
   *
   * @param file_url
   * @param file_name
   * @developer Abhisek Dhua
   */
  public fileDownload(file_url: string, file_name?: string) {
    if (file_url) {
      const link = document.createElement('a');
      if (file_name) link.setAttribute('download', file_name);
      link.href = file_url;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // // other way
      // fetch(file_url)
      //   .then((response) => response.blob())
      //   .then((blob) => {
      //     // Create a download link
      //     var downloadLink = document.createElement('a');
      //     downloadLink.href = URL.createObjectURL(blob);
      //     file_name && downloadLink.setAttribute('download', file_name);
      //     // Trigger a click event to start the download
      //     downloadLink.click();
      //   })
      //   .catch((error) => {
      //     console.error('Error downloading file:', error);
      //   });
    }
  }

  /**
   * File upload handler
   *
   * @param arg
   * @developer Abhisek Dhua
   */
  public onFileSelected(arg: {
    event: Event;
    formControl: AbstractControl<any, any> | null | undefined;
  }): void {
    const file: File = ((arg.event.target as HTMLInputElement).files as FileList)[0];
    if (file) {
      arg.formControl?.markAsDirty();
      arg.formControl?.setValue(file);
    }
  }

  /**
   * File to base64
   *
   * @param file
   * @returns base64 string
   * @developer Abhisek Dhua
   */
  public fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
    });
  }

  /**
   * base64 to File
   *
   * @param data_url base64
   * @param file_name file name
   * @returns File Blob
   * @developer Abhisek Dhua
   */
  dataURLtoFile(data_url: string, file_name: string) {
    const arr = data_url.split(',');
    const mime = arr[0].match(/:(.*?);/)![1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);

    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], file_name, { type: mime });
  }

  /**
   * Reset invalid date form mat datepicker
   *
   * @param event
   * @param formControl
   * @developer Abhisek Dhua
   */
  validateMatDateField(
    event: MatDatepickerInputEvent<Moment | Date>,
    formControl: AbstractControl<any, any> | null | undefined,
  ) {
    if (event.value === null) formControl?.setValue('');
  }

  public getIconByFileExtension(fileName: string | null | undefined) {
    let src = '';
    if (fileName) {
      const extension = fileName.split('.').pop();

      switch (extension) {
        case 'xls':
        case 'xlsx':
          src = './images/excel-file.svg';
          break;
        case 'pdf':
          src = './images/pdf-icon.svg';
          break;
        case 'doc':
        case 'docx':
          src = './images/docx-icon.svg';
          break;
        case 'jpeg':
        case 'png':
        case 'jpg':
          src = './images/image-file.svg';
          break;
        default:
          src = './images/details-image.svg';
          break;
      }
    }
    return src;
  }

  /**
   * Compare two json
   * @param obj1 main json
   * @param obj2 compare with obj2
   * @returns Record<string, string | number>
   */
  public compareJSON(
    obj1: any,
    obj2: any,
    booleanCheck: string[] = [],
    statusCheck: string[] = [],
  ) {
    const result: Record<string, string | number> = {};
    if (obj1 !== undefined && obj2 !== undefined) {
      if (typeof obj1 === 'object' && Array.isArray(obj1)) {
        for (let i = 0; i < obj1.length; i++) {
          this.compareJSON(obj1[i], obj2[i]);
        }
      } else {
        for (const key in obj1) {
          if (obj1[key] !== undefined && obj2[key] !== undefined) {
            if (typeof obj1[key] === 'object' && Array.isArray(obj1[key])) {
              for (let i = 0; i < obj1[key].length; i++) {
                this.compareJSON(obj1[key][i], obj2[key][i]);
              }
            } else if (typeof obj1[key] === 'object') {
              this.compareJSON(obj1[key], obj2[key]);
            } else {
              if (obj1[key] !== obj2[key]) {
                result[key] = booleanCheck.includes(key)
                  ? obj1[key]
                    ? 'Yes'
                    : 'No'
                  : statusCheck.includes(key)
                    ? obj1[key]
                      ? 'Active'
                      : 'Inactive'
                    : obj1[key];
              }
            }
          }
        }
      }
    }
    return result;
  }

  get getListInfoFromQueryParam() {
    let decodedQueryParams;
    const encodedQueryParams = this._route.snapshot.queryParams['enc'];
    if (encodedQueryParams) {
      decodedQueryParams = this._encryptionService.decryptUsingAES256(
        decodeURIComponent(encodedQueryParams),
      );
      const listInfo: Record<string, IListInfo> = decodedQueryParams?.listInfo;
      if (listInfo) {
        return listInfo;
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  }

  get getDecodedQueryParam() {
    let decodedQueryParams = null;
    const encodedQueryParams = this._route.snapshot.queryParams['enc'];
    if (encodedQueryParams) {
      decodedQueryParams = this._encryptionService.decryptUsingAES256(
        decodeURIComponent(encodedQueryParams),
      );
    }
    return decodedQueryParams;
  }

  checkAllPermission() {
    return this._httpService.post('admin/checkAllPermission', {}).pipe(
      map((apiResult) => {
        const accessControl: IACLResponse[] = apiResult.response.data.permissionDetails;
        this._commonService.setAccessControls(accessControl);
        return accessControl;
      }),
      catchError((apiError) => {
        this._router.navigate(['/forbidden']);
        this._toastr.error(apiError.error.response.status.msg, 'error', {
          closeButton: true,
          timeOut: 3000,
        });
        return of(null);
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
  }
}
