import { Directive, HostListener } from '@angular/core';

@Directive({
  selector: '[noSpace]',
  standalone: true,
})
export class NotAllowSpaceDirective {
  @HostListener('keydown', ['$event']) onKeyDown(event: KeyboardEvent): void {
    if (event.key === ' ') {
      event.preventDefault();
    }
  }
}
