import { Directive, HostListener, Optional, Self, Input } from '@angular/core';
import { NgControl } from '@angular/forms';

@Directive({
  selector: '[numberOnlyValidateMaxMin]',
  standalone: true,
})
export class OnlyNumbersAndMinMaxDirective {
  @Input() minNumber!: number;
  @Input() maxNumber!: number;
  @Input() allowDecimal = false;

  private lastValidValue = '';

  constructor(@Optional() @Self() private control: NgControl) {}

  /* FIX: Handle paste separately */
  @HostListener('paste', ['$event'])
  onPaste(event: ClipboardEvent): void {
    const pastedText = event.clipboardData?.getData('text')?.trim() ?? '';

    const validPattern = this.allowDecimal ? /^\d+(\.\d{0,2})?$/ : /^\d+$/;

    if (!validPattern.test(pastedText)) {
      event.preventDefault();
    }
  }

  @HostListener('input', ['$event'])
  onInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    let value = input.value;

    /* ---------- OLD behavior (numbers only) ---------- */
    if (!this.allowDecimal) {
      const sanitized = value.replace(/[^0-9]/g, '');

      if (sanitized === '') {
        this.lastValidValue = '';
        this.syncValue('');
        return;
      }

      const numericValue = Number(sanitized);
      if (
        (this.minNumber !== undefined && numericValue < this.minNumber) ||
        (this.maxNumber !== undefined && numericValue > this.maxNumber)
      ) {
        this.syncValue(this.lastValidValue);
        return;
      }

      this.lastValidValue = sanitized;
      this.syncValue(sanitized);
      return;
    }

    /* ---------- NEW behavior (decimal allowed, max 2 digits) ---------- */
    value = value.replace(/[^0-9.]/g, '');

    // allow only one dot
    const dotIndex = value.indexOf('.');
    if (dotIndex !== -1) {
      const beforeDot = value.substring(0, dotIndex + 1);
      const afterDot = value.substring(dotIndex + 1).replace(/\./g, '');
      value = beforeDot + afterDot;
    }

    // limit to 2 decimal places
    const parts = value.split('.');
    if (parts[1]?.length > 2) {
      value = parts[0] + '.' + parts[1].slice(0, 2);
    }

    if (value === '' || value === '.') {
      this.lastValidValue = '';
      this.syncValue('');
      return;
    }

    const numericValue = Number(value);
    if (
      isNaN(numericValue) ||
      (this.minNumber !== undefined && numericValue < this.minNumber) ||
      (this.maxNumber !== undefined && numericValue > this.maxNumber)
    ) {
      this.syncValue(this.lastValidValue);
      return;
    }

    this.lastValidValue = value;
    this.syncValue(value);
  }

  private syncValue(value: string): void {
    const control = this.control?.control;
    if (!control) return;

    control.setValue(value, {
      emitEvent: true,
      emitModelToViewChange: true,
      emitViewToModelChange: true,
    });
  }
}
