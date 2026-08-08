import {
  Input,
  Output,
  Directive,
  Renderer2,
  ElementRef,
  HostListener,
  EventEmitter,
} from '@angular/core';

@Directive({
  selector: '[textAreaHeight]',
  standalone: true,
})
export class TextAreaHeightDirective {
  @Input() lineCount = 2;
  @Output() heightExits = new EventEmitter<boolean>();

  constructor(
    private el: ElementRef,
    private renderer: Renderer2,
  ) {}

  @HostListener('input')
  onInputEvent() {
    this.updateRowCount();
  }
  @HostListener('keydown')
  onKeyupEvent() {
    this.updateRowCount();
  }

  updateRowCount() {
    const textarea = this.el.nativeElement as HTMLElement;
    const style = getComputedStyle(textarea);

    // // Calculate line height (in pixels)
    const lineHeight = Math.floor(parseFloat(style.fontSize) * 1.2);

    if (lineHeight * this.lineCount >= +this.el.nativeElement.scrollHeight) {
      this.renderer.setStyle(this.el.nativeElement, 'padding', 0);
      this.renderer.setStyle(this.el.nativeElement, 'height', 'auto');
      this.renderer.setStyle(
        this.el.nativeElement,
        'height',
        this.el.nativeElement.scrollHeight + 'px',
      );
    }
  }
}
