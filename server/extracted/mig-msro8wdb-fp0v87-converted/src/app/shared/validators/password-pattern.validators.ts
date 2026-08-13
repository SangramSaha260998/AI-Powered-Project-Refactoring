import { ValidatorFn, AbstractControl, ValidationErrors } from '@angular/forms';

export class passwordPattern {
  static passwordValidation(): ValidatorFn {
    return (controls: AbstractControl): ValidationErrors | null => {
      const value = controls.value;
      const errors: ValidationErrors = {};
      // checking for null
      if (value === null || value === '') {
        return null;
      }
      // checking password strength
      if (!/[A-Z]/g.test(value)) {
        errors['upperCase'] = true;
      }
      if (!/[a-z]/g.test(value)) {
        errors['lowerCase'] = true;
      }
      if (!/[0-9]/g.test(value)) {
        errors['number'] = true;
      }
      if (!/[$&+,:;=?@#|'<>.^*()%!_/\\-]/g.test(value)) {
        errors['specialCharacter'] = true;
      }
      if (!(value.length >= 8 && value.length <= 20)) {
        errors['length'] = true;
      }

      return Object.keys(errors).length ? errors : null;
    };
  }
}
