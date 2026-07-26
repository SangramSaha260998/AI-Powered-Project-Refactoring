import {
  Input,
  NgZone,
  OnInit,
  Output,
  OnDestroy,
  Directive,
  EventEmitter,
  AfterViewInit,
} from '@angular/core';
import { fromEvent, Subject } from 'rxjs';
import { debounceTime, takeUntil, tap } from 'rxjs/operators';
import { MatAutocomplete } from '@angular/material/autocomplete';

@Directive({
  selector: '[matAutocompleteInfiniteScroll]',
  standalone: true,
})
export class MatAutocompleteInfiniteScrollDirective implements OnInit, OnDestroy, AfterViewInit {
  @Input() threshold = '15%';
  @Input() debounceTime = 150;
  @Input() complete!: boolean;
  @Output() infiniteScroll = new EventEmitter<void>();

  private panel!: Element;
  private thrPx = 0;
  private thrPc = 0;
  private singleOptionHeight = 30;

  private destroyed$ = new Subject<boolean>();

  constructor(
    private matAutocomplete: MatAutocomplete,
    private ngZone: NgZone,
  ) {}

  ngOnInit() {
    this.evaluateThreshold();
  }

  ngAfterViewInit() {
    this.matAutocomplete.opened.pipe(takeUntil(this.destroyed$)).subscribe(() => {
      setTimeout(() => {
        this.panel = this.matAutocomplete.panel.nativeElement;
        this.singleOptionHeight = this.getSelectItemHeightPx();
        this.registerScrollListener();
      }, 0);
    });
  }

  evaluateThreshold() {
    if (this.threshold.lastIndexOf('%') > -1) {
      this.thrPx = 0;
      this.thrPc = parseFloat(this.threshold) / 100;
    } else {
      this.thrPx = parseFloat(this.threshold);
      this.thrPc = 0;
    }
  }

  registerScrollListener() {
    fromEvent(this.panel, 'scroll')
      .pipe(
        takeUntil(this.destroyed$),
        debounceTime(this.debounceTime),
        tap((event) => {
          this.handleScrollEvent(event);
        }),
      )
      .subscribe();
  }

  handleScrollEvent(event: Event) {
    this.ngZone.runOutsideAngular(() => {
      if (this.complete) {
        return;
      }
      const countOfRenderedOptions = this.matAutocomplete.options.length;
      const infiniteScrollDistance = this.singleOptionHeight * countOfRenderedOptions;
      const threshold = this.thrPc !== 0 ? infiniteScrollDistance * this.thrPc : this.thrPx;
      const scrolledDistance = this.panel.clientHeight + (event.target as HTMLElement).scrollTop;

      if (scrolledDistance + threshold >= infiniteScrollDistance) {
        this.ngZone.run(() => {
          this.infiniteScroll.emit();
        });
      }
    });
  }

  getSelectItemHeightPx(): number {
    return parseFloat(getComputedStyle(this.panel.children[0]).height);
  }

  ngOnDestroy() {
    this.destroyed$.next(true);
    this.destroyed$.complete();
  }
}
