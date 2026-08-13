import { Directive, EventEmitter, HostListener, Output } from '@angular/core';

@Directive({
  selector: '[shortClick]',
  standalone: true,
})
export class ShortClickDirective {
  private startX: number | null = null;
  private startY: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private movementThreshold = 25; // Movement threshold in pixels
  @Output() shortClick = new EventEmitter<void>();

  @HostListener('mousedown', ['$event']) onMouseDown(event: MouseEvent) {
    this.startX = event.clientX;
    this.startY = event.clientY;

    this.timer = setTimeout(() => {
      this.timer = null; // Invalidate short click after threshold
    }, 250); // Adjust the threshold for short clicks (e.g., 500ms)
  }

  @HostListener('mouseup', ['$event']) onMouseUp(event: MouseEvent) {
    if (this.timer) {
      clearTimeout(this.timer);

      // Check for significant mouse movement
      const movedX = Math.abs((event.clientX || 0) - (this.startX || 0));
      const movedY = Math.abs((event.clientY || 0) - (this.startY || 0));
      const movedDistance = Math.sqrt(movedX ** 2 + movedY ** 2);

      if (movedDistance <= this.movementThreshold) {
        this.shortClick.emit(); // Emit short click if no significant movement
      }
    }
    this.reset();
  }

  @HostListener('mouseleave') onMouseLeave() {
    if (this.timer) {
      clearTimeout(this.timer); // Cancel on mouse leave
    }
    this.reset();
  }

  private reset() {
    this.timer = null;
    this.startX = null;
    this.startY = null;
  }
}
