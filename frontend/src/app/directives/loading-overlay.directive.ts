import { Directive, ElementRef, Input, Renderer2, OnChanges, SimpleChanges } from '@angular/core';

@Directive({
  selector: '[loadingOverlay], [overlayText]',
})
export class LoadingOverlayDirective implements OnChanges {
  @Input('loadingOverlay') isLoading = false;
  @Input() overlayText = 'Searching...';
  private overlayElement: HTMLElement | null = null;

  constructor(
    private el: ElementRef,
    private renderer: Renderer2,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isLoading']) {
      if (this.isLoading) {
        this.showOverlay();
      } else {
        this.hideOverlay();
      }
    }
  }

  private showOverlay() {
    if (this.overlayElement) return;

    const host = this.el.nativeElement;
    this.renderer.setStyle(host, 'position', 'relative');

    // Create overlay container
    this.overlayElement = this.renderer.createElement('div');
    this.renderer.setStyle(this.overlayElement, 'position', 'absolute');
    this.renderer.setStyle(this.overlayElement, 'top', '0');
    this.renderer.setStyle(this.overlayElement, 'left', '0');
    this.renderer.setStyle(this.overlayElement, 'width', '100%');
    this.renderer.setStyle(this.overlayElement, 'height', '100%');
    this.renderer.setStyle(this.overlayElement, 'background', 'rgba(255,255,255,0.7)');
    this.renderer.setStyle(this.overlayElement, 'display', 'flex');
    this.renderer.setStyle(this.overlayElement, 'alignItems', 'center');
    this.renderer.setStyle(this.overlayElement, 'justifyContent', 'center');
    this.renderer.setStyle(this.overlayElement, 'zIndex', '9999');

    // Spinner container
    const spinnerContainer = this.renderer.createElement('div');
    this.renderer.addClass(spinnerContainer, 'spinner');

    // lds-roller
    const ldsRoller = this.renderer.createElement('div');
    this.renderer.addClass(ldsRoller, 'lds-roller');

    for (let i = 0; i < 8; i++) {
      const div = this.renderer.createElement('div');
      this.renderer.appendChild(ldsRoller, div);
    }

    // Loading text
    const text = this.renderer.createText(this.overlayText);
    const textDiv = this.renderer.createElement('div');
    this.renderer.appendChild(textDiv, text);

    // Append spinner parts
    this.renderer.appendChild(spinnerContainer, ldsRoller);
    this.renderer.appendChild(spinnerContainer, textDiv);
    this.renderer.appendChild(this.overlayElement, spinnerContainer);
    this.renderer.appendChild(host, this.overlayElement);

    // Add styles & keyframes
    this.injectStyles();
  }

  private hideOverlay() {
    if (this.overlayElement) {
      const host = this.el.nativeElement;
      this.renderer.removeStyle(host, 'position');
      this.renderer.removeChild(this.el.nativeElement, this.overlayElement);
      this.overlayElement = null;
    }
  }

  private injectStyles() {
    const style = this.renderer.createElement('style');
    style.textContent = `
.spinner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.lds-roller {
  position: relative;
  display: inline-block;
  height: 64px;
  width: 64px;
}

.lds-roller div {
  animation: lds-roller 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  transform-origin: 32px 32px;
}

.lds-roller div:after {
  position: absolute;
  display: block;
  background: #0e4351;
  border-radius: 50%;
  content: " ";
  margin: -3px 0 0 -3px;
  height: 6px;
  width: 6px;
}

.lds-roller div:nth-child(1) {
  animation-delay: -0.036s;
}
.lds-roller div:nth-child(1):after {
  top: 50px;
  left: 50px;
}
.lds-roller div:nth-child(2) {
  animation-delay: -0.072s;
}
.lds-roller div:nth-child(2):after {
  top: 54px;
  left: 45px;
}
.lds-roller div:nth-child(3) {
  animation-delay: -0.108s;
}
.lds-roller div:nth-child(3):after {
  top: 57px;
  left: 39px;
}
.lds-roller div:nth-child(4) {
  animation-delay: -0.144s;
}
.lds-roller div:nth-child(4):after {
  top: 58px;
  left: 32px;
}
.lds-roller div:nth-child(5) {
  animation-delay: -0.18s;
}
.lds-roller div:nth-child(5):after {
  top: 57px;
  left: 25px;
}
.lds-roller div:nth-child(6) {
  animation-delay: -0.216s;
}
.lds-roller div:nth-child(6):after {
  top: 54px;
  left: 19px;
}
.lds-roller div:nth-child(7) {
  animation-delay: -0.252s;
}
.lds-roller div:nth-child(7):after {
  top: 50px;
  left: 14px;
}
.lds-roller div:nth-child(8) {
  animation-delay: -0.288s;
}
.lds-roller div:nth-child(8):after {
  top: 45px;
  left: 10px;
}

@keyframes lds-roller {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
`;
    this.renderer.appendChild(this.overlayElement, style);
  }
}
