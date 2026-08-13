import { OnInit, Output, Directive, ElementRef, EventEmitter, HostListener } from '@angular/core';
import { fromEvent } from 'rxjs';
import { take } from 'rxjs/operators';

@Directive({
  selector: '[clickOutside]',
  standalone: true,
})
export class ClickOutsideDirective implements OnInit {
  /**
   * *Directive for handling click events outside an element
   * *Useful for things like reacting to clicking outside of a dropdown menu or modal dialog.
   *
   * @date 12 April 2021
   * @developer Somnath Sil
   */

  @Output()
  public clickOutside = new EventEmitter<any>();
  private captured = false;

  constructor(private _elementRef: ElementRef) {}

  @HostListener('document:click', ['$event.target'])
  onClick(target: HTMLElement) {
    if (!this.captured) {
      return;
    }

    if (!this._elementRef.nativeElement.contains(target)) {
      this.clickOutside.emit();
    }
  }

  ngOnInit() {
    fromEvent(document, 'click', { capture: true })
      .pipe(take(1))
      .subscribe(() => (this.captured = true));
  }
}
