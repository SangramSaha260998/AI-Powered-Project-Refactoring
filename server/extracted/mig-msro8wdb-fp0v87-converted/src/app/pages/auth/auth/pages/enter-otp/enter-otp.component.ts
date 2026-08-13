import {
  inject,
  OnInit,
  Component,
  OnDestroy,
  ViewChild,
  ElementRef,
  CUSTOM_ELEMENTS_SCHEMA,
  AfterViewInit,
} from '@angular/core';
  FormGroup,
  Validators,
  FormControl,
  FormBuilder,
  FormsModule,
  ReactiveFormsModule,
} from '@angular/forms';
import { Observable, Subscription, take, timer } from 'rxjs';
import { ToastrService } from 'ngx-toastr';
import { CommonModule } from '@angular/common';
import { EncryptionService } from '@app/core/services';
import { AuthenticationService } from '@app/core/authentication';
import { ActivatedRoute, Router, RouterModule, RouterLink } from '@angular/router';
import { fadeAnimation } from '@app/shared/animations';
import { appSettings } from '@app/config';
import { ReactiveFormsModule } from '@angular/forms';

@Component({
  styleUrl: './enter-otp.component.scss',
  standalone: true,
  selector: 'enter-otp',
  imports: [CommonModule, RouterModule, FormsModule, ReactiveFormsModule, RouterLink],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './enter-otp.component.html',
  
  animations: [fadeAnimation]
})
export class EnterOtpComponent implements OnInit, AfterViewInit, OnDestroy {
  /** Injecting required services **/
  private _router = inject(Router);
  private _toaster = inject(ToastrService);
  private _formBuilder = inject(FormBuilder);
  private _activatedRoute = inject(ActivatedRoute);
  private _encryptService = inject(EncryptionService);
  private _authService = inject(AuthenticationService);

  /** Private global variables **/
  private subscriptions: Subscription[] = [];

  /** Public global variables **/
  public userName = '';
  public isPaste = false;
  public submitted = false;
  public isDisabled = false;
  public verifyOtpForm!: FormGroup;
  public timer$!: Observable<number>; // Observable for the countdown timer
  public timerSubscription: Subscription | undefined; // Timer subscription
  public remainingTime = 0; // Time in seconds
  public message = ''; // Message to show (OTP expiration or success)
  public otp_timer = false;
  public showMessage: { type: string; message: string } | null = null;

  @ViewChild('digit1') digit1Ref!: ElementRef;

  /**
   * *Component init life cycle hook
   */
  ngOnInit(): void {
    this.queryParams();
    this.initVerifyOtpFrom();
    const otpRemainingTime = localStorage.getItem('otp_remaining_time');
    if (otpRemainingTime) {
      this.remainingTime = Number(otpRemainingTime);
    }
    if (!otpRemainingTime || (otpRemainingTime && +otpRemainingTime > 0)) {
      this.startOtpTimer();
    }
  }
  ngAfterViewInit(): void {
    this.digit1Ref?.nativeElement?.focus();
  }
  /**
   * Get username from param
   */
  queryParams() {
    this._activatedRoute.queryParams.subscribe((param) => {
      if (param['enc']) {
        const decryptData = this._encryptService.decryptUsingAES256(
          decodeURIComponent(param['enc']),
        );
        if (decryptData.username) {
          this.userName = decryptData.username;
        } else {
          this._router.navigate(['/forgot-password']);
        }
      }
      // else {
      //   this._router.navigate(['/forgot-password']);
      // }
    });
  }

  /**
   * *Initializing form for verify otp
   */
  private initVerifyOtpFrom() {
    this.verifyOtpForm = this._formBuilder.group({
      digit1: new FormControl('', [Validators.required]),
      digit2: new FormControl('', [Validators.required]),
      digit3: new FormControl('', [Validators.required]),
      digit4: new FormControl('', [Validators.required])
    });
    Object.values(this.verifyOtpForm.controls).forEach((control) => {
      this.subscriptions.push(
        control.valueChanges.subscribe(() => {
          this.submitted = false;
        }),
      );
    });
  }

  /**
   * *Getting all form controls from forgot password form
   */
  get formControl() {
    return this.verifyOtpForm.controls;
  }

  /**
   * Go to next input filed automatically after fill
   * @param fromText
   * @param qurentText
   * @param totext
   * @param event
   */
  moveToNext(
    fromText: HTMLInputElement | null,
    qurentText: HTMLInputElement,
    totext: HTMLInputElement | null,
    event: KeyboardEvent,
  ) {
    const key = event.key; // const {key} = event; ES6+
    if (key === 'Backspace' || key === 'Delete' || key === 'ArrowLeft' || key === 'ArrowRight') {
      if (key === 'ArrowRight') {
        if (totext) totext.focus();
      } else {
        if (fromText) fromText.focus();
      }
    } else {
      setTimeout(() => {
        let value = qurentText.value;
        // Keep only the first digit if multiple characters were typed
        if (value.length > 1) {
          value = value.charAt(0);
          qurentText.value = value;
        }
        const controlName = qurentText.getAttribute('formcontrolname');
        if (/^[0-9]$/.test(value)) {
          if (controlName) this.verifyOtpForm.controls[controlName].setValue(value);
          if (totext) {
            totext.focus();
          }
          if (this.verifyOtpForm.valid) {
            this.onSubmitVerifyOtpFrom();
          }
        } else {
          if (controlName) this.verifyOtpForm.controls[controlName].setValue('');
        }
      });
    }
  }

  /**
   * For handle past functionality in any filed
   * @param event
   */
  handlePaste(event: ClipboardEvent) {
    event.preventDefault();
    this.isPaste = true;
    const pasteData = event.clipboardData?.getData('text').trim();

    if (pasteData && /^[0-9]{4}$/.test(pasteData)) {
      for (let i = 0; i < 4; i++) {
        this.verifyOtpForm.controls[`digit${i + 1}`].setValue(pasteData[i]);
      }
      this.onSubmitVerifyOtpFrom();
    } else {
      this._toaster.error('Invalid OTP', 'Error', {
        closeButton: true,
        tapToDismiss: false,
        timeOut: 3000
      });

      // Clear form
      Object.keys(this.verifyOtpForm.controls).forEach((key) => {
        this.verifyOtpForm.controls[key].setValue('');
      });

      this.digit1Ref?.nativeElement?.focus();
    }

    // Reset the flag after short delay to avoid premature clearing
    setTimeout(() => {
      this.isPaste = false;
    }, 500);
  }

  /**
   * Submit form for OTP verification
   */
  onSubmitVerifyOtpFrom() {
    if (!this.isDisabled) {
      this.submitted = true;
      const formValue = this.verifyOtpForm.getRawValue();
      const payload = {
        username: this.userName,
        otp: formValue.digit1 + formValue.digit2 + formValue.digit3 + formValue.digit4,
      };
      if (this.verifyOtpForm.valid) {
        this.isDisabled = true;
        this.subscriptions.push(
          this._authService.verifyOtp(payload).subscribe({
            next: (apiResult) => {
              this.isDisabled = false;
              if (apiResult.response.status.action_status) {
                this._router.navigate(['/reset-password'], {
                  queryParams: {
                    enc: encodeURIComponent(
                      this._encryptService.encryptUsingAES256({ username: this.userName }),
                    ),
                  }
                });
                this._toaster.success(apiResult.response.status.msg, 'Success', {
                  closeButton: true,
                  tapToDismiss: false,
                  timeOut: 3000
                });
              }
            },
            error: (err) => {
              this.isDisabled = false;
              this._toaster.error(err.error.response.status.msg, 'Error', {
                closeButton: true,
                tapToDismiss: false,
                timeOut: 3000
              });
            }
          }),
        );
      }
    }
  }

  //  otp timer

  startOtpTimer(): void {
    this.message = `OTP is valid for ${this.remainingTime} seconds.`;
    this.timer$ = timer(0, 1000).pipe(
      take(this.remainingTime), // Emit values up to the remaining time
    );

    // Subscribe to the timer observable to update the countdown
    this.timerSubscription = this.timer$.subscribe({
      next: () => {
        this.remainingTime = this.remainingTime - 1; // Decrease remaining time}
        localStorage.setItem('otp_remaining_time', this.remainingTime.toString());
        if (this.remainingTime === 0) {
          this.timerSubscription?.unsubscribe();
        }
      },
      complete: () => {
        // When timer completes (expires), disable OTP
        // this.otp = ''; // Clear the OTP
      }
    });
  }
  /**
   * Resend otp again
   */
  resendOtp() {
    if (this.userName && !this.isDisabled) {
      this.isDisabled = true;
      this.subscriptions.push(
        this._authService.forgetPassword(this.userName).subscribe({
          next: () => {
            this.remainingTime = appSettings.otpTime;
            this.startOtpTimer();
            this.isDisabled = false;
          },
          error: (err) => {
            this._toaster.error(err.error.response.status.msg, 'Error', {
              closeButton: true,
              tapToDismiss: false,
              timeOut: 3000
            });
            this.isDisabled = false;
          }
        }),
      );
    }
  }

  /**
   * *Unsubscribing observable on destroy
   */
  ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
    this.timerSubscription?.unsubscribe();
    localStorage.removeItem('otp_remaining_time');
  }
}
