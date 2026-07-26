import { Directive, HostListener, Optional, Self } from '@angular/core';
import { NgControl } from '@angular/forms';

@Directive({
  selector: '[numberOnly]',
  standalone: true,
})
export class OnlyNumbersDirective {
  constructor(@Optional() @Self() private control: NgControl) {}

  @HostListener('input', ['$event'])
  onInput(event: Event): void {
    const input = event.target as HTMLInputElement;

    // Remove everything except digits
    let sanitizedValue = input.value.replace(/[^0-9]/g, '');

    // Avoid space at the start (optional depending on input method)
    if (sanitizedValue.startsWith(' ')) {
      sanitizedValue = sanitizedValue.trimStart();
    }

    // Update input and control value
    input.value = sanitizedValue;
    if (this.control && this.control.control) {
      this.control.control.setValue(sanitizedValue, { emitEvent: false });
    }
  }
}
