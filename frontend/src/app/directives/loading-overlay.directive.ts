import { Directive, ElementRef, Input, Renderer2, OnChanges, SimpleChanges } from '@angular/core';

@Directive({
  selector: '[loadingOverlay], [overlayText]',
})
export class LoadingOverlayDirective implements OnChanges {
  @Input('loadingOverlay') isLoading = false;
  @Input() overlayText = 'Searching...';
  @Input() progressPercent: number = -1; // -1 = indeterminate, 0-100 = determinate
  @Input() currentStep: string = '';
  @Input() totalSteps: number = 0;
  @Input() currentStepIndex: number = 0;
  private overlayElement: HTMLElement | null = null;
  private textNode: Text | null = null;
  private progressBar: HTMLElement | null = null;
  private progressFill: HTMLElement | null = null;
  private stepIndicator: HTMLElement | null = null;

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

    if (changes['overlayText'] && this.overlayElement && this.textNode) {
      this.textNode.textContent = this.overlayText || '';
    }

    if ((changes['progressPercent'] || changes['currentStep'] || changes['currentStepIndex']) && this.overlayElement) {
      this.updateProgress();
    }
  }

  private showOverlay() {
    if (this.overlayElement) {
      if (this.textNode) {
        this.textNode.textContent = this.overlayText || '';
      }
      return;
    }

    const host = this.el.nativeElement;
    this.renderer.setStyle(host, 'position', 'relative');

    // Create overlay container
    this.overlayElement = this.renderer.createElement('div');
    this.renderer.setStyle(this.overlayElement, 'position', 'absolute');
    this.renderer.setStyle(this.overlayElement, 'top', '0');
    this.renderer.setStyle(this.overlayElement, 'left', '0');
    this.renderer.setStyle(this.overlayElement, 'width', '100%');
    this.renderer.setStyle(this.overlayElement, 'height', '100%');
    this.renderer.setStyle(this.overlayElement, 'background', 'var(--overlay-bg)');
    this.renderer.setStyle(this.overlayElement, 'color', 'var(--text-primary)');
    this.renderer.setStyle(this.overlayElement, 'backdropFilter', 'blur(2px)');
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

    // Loading text (kept as a node so progress updates can rewrite it)
    this.textNode = this.renderer.createText(this.overlayText);
    const textDiv = this.renderer.createElement('div');
    this.renderer.setStyle(textDiv, 'maxWidth', 'min(520px, 90vw)');
    this.renderer.setStyle(textDiv, 'textAlign', 'center');
    this.renderer.setStyle(textDiv, 'padding', '0 12px');
    this.renderer.setStyle(textDiv, 'lineHeight', '1.4');
    this.renderer.appendChild(textDiv, this.textNode);

    // Progress bar container
    this.progressBar = this.renderer.createElement('div');
    this.renderer.addClass(this.progressBar, 'progress-bar-container');
    this.renderer.setStyle(this.progressBar, 'width', '100%');
    this.renderer.setStyle(this.progressBar, 'maxWidth', '300px');
    this.renderer.setStyle(this.progressBar, 'height', '6px');
    this.renderer.setStyle(this.progressBar, 'background', 'rgba(255,255,255,0.2)');
    this.renderer.setStyle(this.progressBar, 'borderRadius', '3px');
    this.renderer.setStyle(this.progressBar, 'overflow', 'hidden');
    this.renderer.setStyle(this.progressBar, 'marginTop', '16px');
    this.renderer.setStyle(this.progressBar, 'margin', '16px auto 0');

    // Progress fill bar
    this.progressFill = this.renderer.createElement('div');
    this.renderer.addClass(this.progressFill, 'progress-fill');
    this.renderer.setStyle(this.progressFill, 'height', '100%');
    this.renderer.setStyle(this.progressFill, 'background', 'var(--spinner-color)');
    this.renderer.setStyle(this.progressFill, 'borderRadius', '3px');
    this.renderer.setStyle(this.progressFill, 'transition', 'width 0.3s ease-in-out');
    this.renderer.setStyle(this.progressFill, 'width', '0%');
    this.renderer.appendChild(this.progressBar, this.progressFill);

    // Step indicator
    this.stepIndicator = this.renderer.createElement('div');
    this.renderer.addClass(this.stepIndicator, 'step-indicator');
    this.renderer.setStyle(this.stepIndicator, 'marginTop', '12px');
    this.renderer.setStyle(this.stepIndicator, 'fontSize', '13px');
    this.renderer.setStyle(this.stepIndicator, 'opacity', '0.8');
    this.renderer.setStyle(this.stepIndicator, 'letterSpacing', '0.5px');
    if (this.currentStep && this.stepIndicator) {
      this.stepIndicator.textContent = this.currentStep;
    }

    // Append spinner parts
    this.renderer.appendChild(spinnerContainer, ldsRoller);
    this.renderer.appendChild(spinnerContainer, textDiv);
    this.renderer.appendChild(spinnerContainer, this.progressBar);
    this.renderer.appendChild(spinnerContainer, this.stepIndicator);
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
      this.textNode = null;
    }
  }

  private updateProgress() {
    if (!this.progressFill || !this.stepIndicator) return;

    // Update progress bar
    if (this.progressPercent >= 0 && this.progressPercent <= 100) {
      this.renderer.setStyle(this.progressFill, 'width', `${this.progressPercent}%`);
    } else {
      // Indeterminate - show animated stripe
      this.renderer.setStyle(this.progressFill, 'width', '100%');
      this.renderer.setStyle(this.progressFill, 'background', 'linear-gradient(90deg, var(--spinner-color) 0%, transparent 50%, var(--spinner-color) 100%)');
      this.renderer.setStyle(this.progressFill, 'backgroundSize', '200% 100%');
      this.renderer.setStyle(this.progressFill, 'animation', 'progress-stripe 1.5s linear infinite');
    }

    // Update step indicator
    if (this.stepIndicator) {
      if (this.totalSteps > 0 && this.currentStepIndex > 0) {
        this.stepIndicator.textContent = `Step ${this.currentStepIndex} of ${this.totalSteps}: ${this.currentStep}`;
      } else if (this.currentStep) {
        this.stepIndicator.textContent = this.currentStep;
      }
    }
  }

  private injectStyles() {
    const style = this.renderer.createElement('style');
    style.textContent = `
@keyframes progress-stripe {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.spinner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
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
  background: var(--spinner-color);
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
