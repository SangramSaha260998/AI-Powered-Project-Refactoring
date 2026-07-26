import {
  Directive,
  ElementRef,
  EventEmitter,
  HostListener,
  Output,
  Renderer2,
} from '@angular/core';

@Directive({
  selector: '[horizontalDragScroll]',
  standalone: true,
})
export class HorizontalDragScrollDirective {
  private startX = 0;
  private isDragging = false;
  private initialScrollLeft = 0;
  @Output() draggingCursor = new EventEmitter<boolean>();

  constructor(
    private el: ElementRef,
    private renderer: Renderer2,
  ) {
    this.draggingCursor.emit(this.isDragging);
    this.renderer.setStyle(this.el.nativeElement, 'cursor', 'grab');
    this.renderer.setStyle(this.el.nativeElement, 'overflow-x', 'auto');
    this.renderer.setStyle(this.el.nativeElement, 'scroll-behavior', 'auto'); // Disable smooth scroll for manual dragging
  }

  @HostListener('mousedown', ['$event'])
  onMouseDown(event: MouseEvent): void {
    this.isDragging = true;
    this.draggingCursor.emit(this.isDragging);
    this.startX = event.pageX; // Store the initial mouse position
    this.initialScrollLeft = this.el.nativeElement.scrollLeft; // Store the initial scroll position

    this.renderer.setStyle(this.el.nativeElement, 'cursor', 'grabbing');
    this.renderer.setStyle(this.el.nativeElement, 'user-select', 'none'); // Disable text selection
  }

  @HostListener('mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (!this.isDragging) return;

    const deltaX = event.pageX - this.startX; // Calculate movement distance
    this.el.nativeElement.scrollLeft = this.initialScrollLeft - deltaX; // Adjust scroll directly based on movement
  }

  @HostListener('mouseup')
  @HostListener('mouseleave')
  onMouseUpOrLeave(): void {
    if (!this.isDragging) return;

    this.isDragging = false;
    this.draggingCursor.emit(this.isDragging);
    this.renderer.setStyle(this.el.nativeElement, 'cursor', 'grab');
    this.renderer.removeStyle(this.el.nativeElement, 'user-select'); // Re-enable text selection
  }
}
