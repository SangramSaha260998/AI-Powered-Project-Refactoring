import { ValidatorFn, AbstractControl, ValidationErrors } from '@angular/forms';

/** custom validator for date range */
export function dateRangeValidator(startDate: string, endDate: string): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const start = control.get(startDate);
    const end = control.get(endDate);
    if (start && end) {
      const startDate = new Date(start.value);
      const endDate = new Date(end.value);
      if (startDate.getTime() === endDate.getTime()) {
        end.setErrors({ sameDate: true });
        return { sameDate: true };
      } else {
        end.setErrors(null);
        return null;
      }
    } else {
      return null;
    }
  };
}
