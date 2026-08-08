import { NgControl } from '@angular/forms';
import { Directive, HostListener, ElementRef, Optional, Self } from '@angular/core';

@Directive({
  selector: '[noLeadingWhitespace]',
  standalone: true,
})
export class NotAllowWhiteSpaceAtStartDirective {
  constructor(
    private el: ElementRef,
    @Optional() @Self() private control: NgControl,
  ) {}

  @HostListener('input') onInput(): void {
    const input = this.el.nativeElement as HTMLInputElement;
    const trimmed = input.value.replace(/^\s+/, '');

    // Only update if value actually changed
    if (trimmed !== input.value) {
      input.value = trimmed;

      // Update the form control if it's bound
      if (this.control && this.control.control) {
        this.control.control.setValue(trimmed, { emitEvent: false });
      }
    }
  }
}
