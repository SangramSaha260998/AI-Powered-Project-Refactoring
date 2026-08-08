import { Directive, HostListener } from '@angular/core';

@Directive({
  selector: '[noSpecialCharacters]',
  standalone: true,
})
export class NoSpecialCharactersDirective {
  @HostListener('keypress', ['$event']) onKeyPress(event: KeyboardEvent) {
    const allowedCharacters = /^[a-zA-Z0-9 ]$/; // Alphanumeric and spaces
    if (!allowedCharacters.test(event.key)) {
      event.preventDefault();
    }
  }
}
