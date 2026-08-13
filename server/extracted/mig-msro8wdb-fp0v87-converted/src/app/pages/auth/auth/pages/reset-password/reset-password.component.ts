import {
  FormGroup,
  Validators,
  FormBuilder,
  FormControl,
  FormsModule,
  ReactiveFormsModule,
} from '@angular/forms';
import { Subscription } from 'rxjs';
import { ToastrService } from 'ngx-toastr';
import { CommonModule } from '@angular/common';
import { EncryptionService } from '@app/core/services';
import { fadeAnimation } from '@app/shared/animations';
import { ActivatedRoute, Router, RouterModule, RouterLink } from '@angular/router';
import { AuthenticationService } from '@app/core/authentication';
import { passwordPattern, PasswordValidator } from '@app/shared/validators';
import { Component, CUSTOM_ELEMENTS_SCHEMA, inject, OnDestroy, OnInit } from '@angular/core';
@Component({
  styleUrl: './reset-password.component.scss',
  standalone: true,
  selector: 'reset-password',
  imports: [CommonModule, RouterModule, FormsModule, ReactiveFormsModule, RouterLink],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './reset-password.component.html',
  
  animations: [fadeAnimation]
})
export class ResetPasswordComponent implements OnInit, OnDestroy {
  /** Injecting required services **/
  private _router = inject(Router);
  private _toastr = inject(ToastrService);
  private _formBuilder = inject(FormBuilder);
  private _activatedRoute = inject(ActivatedRoute);
  private _authService = inject(AuthenticationService);
  private _encryptionService = inject(EncryptionService);

  /** Private global variables **/
  private subscriptions: Subscription[] = [];

  /** Public global variables **/
  public userName = '';
  public submitted = false;
  public showTypeNewPassword = false;
  public showTypeConfirmPassword = false;
  public isDisabled = false;
  public isResetPasswordSuccess = false;
  public createPasswordForm!: FormGroup;

  /**
   * *Component init life cycle hook
   */
  ngOnInit(): void {
    this.initCreatePasswordForm();
    this.getQueryParam();
  }

  /**
   * *Initializing form controls in create password form
   */
  private initCreatePasswordForm(): void {
    this.createPasswordForm = this._formBuilder.group(
      {
        new_password: new FormControl('', {
          validators: [Validators.required, passwordPattern.passwordValidation()]
        }),
        confirm_password: new FormControl('', {
          validators: [Validators.required]
        }),
      },
      {
        validators: PasswordValidator.passwordsMustMatch('new_password', 'confirm_password'),
      },
    );
  }

  /**
   * *get query param value
   */
  getQueryParam() {
    this.subscriptions.push(
      this._activatedRoute.queryParams.subscribe((param) => {
        if (param['enc']) {
          const decryptData = this._encryptionService.decryptUsingAES256(
            decodeURIComponent(param['enc']),
          );
          if (decryptData.username) {
            this.userName = decryptData.username;
          } else {
            this._router.navigate(['/forgot-password']);
          }
        }
      }),
    );
  }

  /**
   * *Getting all form controls create password form
   */
  get formControl() {
    return this.createPasswordForm.controls;
  }

  /**
   * *Checking if control has error
   *
   * @param field form control name
   * @returns boolean
   */
  public hasFormControlError(field: string): boolean {
    const control = this.createPasswordForm.get(field) as FormControl;
    if ((this.submitted && control.errors) || (control.invalid && control.dirty)) {
      return true;
    }
    return false;
  }

  /**
   * *If user clicked show poassword icon
   */
  showPassword(event: Event, name: string) {
    event.preventDefault();
    if (name === 'showTypeNewPassword') {
      this.showTypeNewPassword = !this.showTypeNewPassword;
    }
    if (name === 'showTypeConfirmPassword') {
      this.showTypeConfirmPassword = !this.showTypeConfirmPassword;
    }
  }

  /**
   * *get password validation
   */
  get newPasswordValidationCheck() {
    return (
      this.formControl['new_password'].errors?.['upperCase'] ||
      this.formControl['new_password'].errors?.['lowerCase'] ||
      this.formControl['new_password'].errors?.['number'] ||
      this.formControl['new_password'].errors?.['specialCharacter'] ||
      this.formControl['new_password'].errors?.['length']
    );
  }

  /**
   * * user create password form submit
   */
  public onSubmitCreatePasswordForm(): boolean | void {
    this.submitted = true;
    if (!this.isDisabled && this.createPasswordForm.valid) {
      this.isDisabled = true;
      const formValue = this.createPasswordForm.getRawValue();
      const param: ICreatePasswordParam = {
        username: this.userName,
        new_password: formValue.new_password,
        confirm_password: formValue.confirm_password,
      };
      this.subscriptions.push(
        this._authService.resetPassword(param).subscribe({
          next: (result) => {
            this.submitted = false;
            this.isDisabled = false;
            this.isResetPasswordSuccess = true;
            this._toastr.success(result.response.status.msg, 'Success', {
              closeButton: true,
              timeOut: 3000
            });
          },
          error: (error) => {
            this.submitted = false;
            this.isDisabled = false;
            this._toastr.error(error.error.response.status.msg, 'Error', {
              closeButton: true,
              timeOut: 3000
            });
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
  }
}
