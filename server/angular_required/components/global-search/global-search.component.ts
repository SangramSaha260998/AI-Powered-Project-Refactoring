import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Component, input, OnDestroy, output, signal } from '@angular/core';
import { BehaviorSubject, debounceTime, pairwise, Subscription } from 'rxjs';

@Component({
  selector: 'global-search',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule],
  templateUrl: './global-search.component.html',
  styleUrl: './global-search.component.scss',
})
export class GlobalSearchComponent implements OnDestroy {
  public valueChange = output<string>();
  public searchModel = signal<string>('');
  private skipEmit = signal<boolean>(false);
  private subscriptions: Subscription[] = [];
  public searchPlaceholder = input<string>('Search');
  public searchModel$ = new BehaviorSubject<string>('');

  constructor() {
    /* Init debounce search */
    this.subscriptions.push(
      this.searchModel$.pipe(pairwise(), debounceTime(800)).subscribe({
        next: ([previousValue, currentValue]) => {
          if (this.skipEmit()) {
            this.skipEmit.set(false);
            return;
          }
          if ((!!previousValue.trim() && !currentValue.trim()) || !!currentValue.trim()) {
            this.valueChange.emit(currentValue.trim());
          }
        },
      }),
    );
  }

  /**
   * On change search value for internal use only
   */
  onSearchValueChange() {
    this.searchModel$.next(this.searchModel());
  }

  /**
   * Clear value with emit event
   */
  onClearValue() {
    this.searchModel.set('');
    this.searchModel$.next('');
  }

  /**
   * Set value without emit event
   * @param value
   */
  setSearchModel(value: string) {
    this.skipEmit.set(true);
    this.searchModel.set(value);
    this.searchModel$.next(value);
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
  }
}
