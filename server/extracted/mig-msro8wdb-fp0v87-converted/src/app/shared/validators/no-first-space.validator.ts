import { AbstractControl, ValidationErrors } from '@angular/forms';

export class NoFirstSpace {
  static noSpaceAllowed(control: AbstractControl): ValidationErrors | null {
    if (
      control.value?.startsWith(' ') ||
      control.value === '<p></p>' ||
      control.value?.startsWith('<p>&nbsp;') ||
      control.value?.startsWith('<p> ') ||
      control.value?.startsWith('\n')
    ) {
      return { noSpaceAllowed: true };
    }

    return null;
  }
}
