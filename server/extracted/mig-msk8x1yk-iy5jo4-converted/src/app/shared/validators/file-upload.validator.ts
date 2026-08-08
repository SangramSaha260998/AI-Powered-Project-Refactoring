import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

export function fileErrorValidators(arg: {
  fileTypes?: string[];
  fileSize?: number; // in MB
}): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    const allowedFileTypes = [
      'jpeg',
      'jpg',
      'png',
      'csv',
      'xls',
      'xlsx',
      'doc',
      'docx',
      'pdf',
      'txt',
      'webp',
    ];

    // return if controls are null
    if (value === null || value === '') {
      return null;
    }

    // return if another validator has already found an error on the validator function
    if (
      control.invalid &&
      control?.errors &&
      (!control.errors['invalidFileType'] || !control.errors['invalidFileSize'])
    ) {
      return null;
    }

    // checking controls values is file or not
    if (typeof value === 'object' && value instanceof File) {
      const fileSize = value.size / (1000 * 1000); // in MB
      const fileExtension = value.name.split('.').pop()?.toLowerCase() ?? '';

      // if file type miss match
      if ((arg.fileTypes ? arg.fileTypes : allowedFileTypes).indexOf(fileExtension) === -1) {
        return { invalidFileType: true };
      }
      // if file size exist or allow upto 300 MB
      else if (fileSize > (arg.fileSize ? arg.fileSize : 300)) {
        return { invalidFileSize: true };
      } else {
        return null;
      }
    } else {
      // not a file
      return null;
    }
  };
}
