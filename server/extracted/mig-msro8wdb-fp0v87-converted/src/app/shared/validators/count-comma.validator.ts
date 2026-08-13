import { AbstractControl, ValidationErrors } from '@angular/forms';

export class countComma {
  static tooManyComma(control: AbstractControl): ValidationErrors | null {
    const description = control.value as string;
    const commaCount = description.split(',').length - 1;
    if (commaCount > 10) {
      return { tooManyComma: true };
    }

    return null;
  }
}
