import { Input, OnInit, Output, OnDestroy, Directive, EventEmitter } from '@angular/core';
import { NgModel } from '@angular/forms';
import { debounceTime, distinctUntilChanged, skip, Subscription } from 'rxjs';

@Directive({
  selector: '[ngModelDebounce]',
  standalone: true,
})
export class NgModelDebounceDirective implements OnDestroy, OnInit {
  constructor(private ngModel: NgModel) {}

  @Input() ngModelDebounceTime = 600;
  private subscription!: Subscription;
  @Output() ngModelDebounceChange: EventEmitter<string> = new EventEmitter<string>();

  ngOnInit(): void {
    this.onModelValueChange();
  }

  /**
   * *Event listener function that emits the debounced value of the NgModel control
   * *when its value changes.
   *
   * @remarks
   * This function subscribes to the `valueChanges` observable of the NgModel control and
   * emits its value only after a specified debounce time has passed. The emitted value
   * is passed through the `ngModelDebounceChange` EventEmitter for use by the parent component.
   */
  private onModelValueChange(): void {
    this.subscription = this.ngModel.control.valueChanges
      .pipe(skip(1), distinctUntilChanged(), debounceTime(this.ngModelDebounceTime))
      .subscribe({
        next: (value: string) => {
          this.ngModelDebounceChange.emit(value);
        },
      });
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }
}
