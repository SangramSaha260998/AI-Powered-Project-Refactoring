import {
  FormGroup,
  Validators,
  FormsModule,
  FormControl,
  FormBuilder,
  ReactiveFormsModule,
} from '@angular/forms';
import { Subscription } from 'rxjs';
import { appSettings } from '@app/config';
import { ToastrService } from 'ngx-toastr';
import { CommonModule } from '@angular/common';
import { Router, RouterModule, RouterLink } from '@angular/router';
import { EncryptionService } from '@app/core/services';
import { fadeAnimation } from '@app/shared/animations';
import { AuthenticationService } from '@app/core/authentication';
import { Component, CUSTOM_ELEMENTS_SCHEMA, inject, OnDestroy, OnInit } from '@angular/core';

@Component({
  styleUrl: './forgot-password.component.scss',
  standalone: true,
  selector: 'forgot-password',
  imports: [CommonModule, FormsModule, ReactiveFormsModule, RouterModule, RouterLink],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './forgot-password.component.html',
  
  animations: [fadeAnimation]
})
export class ForgotPasswordComponent implements OnInit, OnDestroy {
  /** Injecting required services **/
  private _router = inject(Router);
  private _toaster = inject(ToastrService);
  private _formBuilder = inject(FormBuilder);
  private _encryptService = inject(EncryptionService);
  private _authService = inject(AuthenticationService);

  /** Private global variables **/
  private subscriptions: Subscription[] = [];
  private emailPattern = appSettings.emailPattern;

  /** Public global variables **/
  public submitted = false;
  public isDisabled = false;
  public remainingTime = appSettings.otpTime;
  public forgotPasswordForm!: FormGroup;
  // public currentYear = signal(new Date().getFullYear());

  /**
   * *Component init life cycle hook
   */
  ngOnInit(): void {
    this.initForgotPasswordForm();
  }

  /**
   * *Initializing form controls in forgot password form
   */
  private initForgotPasswordForm() {
    this.forgotPasswordForm = this._formBuilder.group({
      username: new FormControl('', [Validators.required])
    });
  }

  /**
   * *Getting all form controls from forgot password form
   */
  get formControl() {
    return this.forgotPasswordForm.controls;
  }

  /**
   * *Checking if control has error
   *
   * @param field form control name
   * @returns boolean
   */
  public hasFormControlError(field: string): boolean {
    const control = this.forgotPasswordForm.get(field) as FormControl;
    if (this.submitted && (control.errors || control.invalid)) {
      return true;
    }
    return false;
  }

  /**
   * *Submitting forgot password form
   * @returns boolean | void
   */
  public onSubmitForgotPasswordForm(): boolean | void {
    if (!this.isDisabled) {
      this.submitted = true;
      const formValue = this.forgotPasswordForm.getRawValue();
      if (this.forgotPasswordForm.valid) {
        this.isDisabled = true;
        this.subscriptions.push(
          this._authService.forgetPassword(formValue.username).subscribe({
            next: (apiResult) => {
              this.isDisabled = false;
              if (apiResult.response.data.is_valid) {
                localStorage.setItem('otp_remaining_time', this.remainingTime.toString());
                this._router.navigate(['/enter-otp'], {
                  queryParams: {
                    enc: encodeURIComponent(
                      this._encryptService.encryptUsingAES256({ username: formValue.username }),
                    ),
                  }
                });
              }
              this._toaster.success(apiResult.response.status.msg, 'Success', {
                closeButton: true,
                tapToDismiss: false,
                timeOut: 3000
              });
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

  /**
   * *Unsubscribing observable on destroy
   */
  ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
  }
}
