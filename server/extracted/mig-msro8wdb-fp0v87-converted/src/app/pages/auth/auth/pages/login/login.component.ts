import { inject, OnInit, Component, OnDestroy, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import {
  FormGroup,
  Validators,
  FormsModule,
  FormControl,
  FormBuilder,
  ReactiveFormsModule,
} from '@angular/forms';
import { of, Subscription, switchMap } from 'rxjs';
import { appSettings } from '@app/config';
import { ToastrService } from 'ngx-toastr';
import { CommonModule } from '@angular/common';
import { CookieService } from 'ngx-cookie-service';
import { ActivatedRoute, Router, RouterModule, RouterLink } from '@angular/router';
import { fadeAnimation } from '@app/shared/animations';
import { DeepLinkingRoutesService, EncryptionService } from '@app/core/services';
import { NotAllowSpaceDirective } from '@app/shared/directives';
import { AuthenticationService } from '@app/core/authentication';
import { SetLoginDetails } from '@app/store';
import { Store } from '@ngxs/store';

@Component({
  styleUrl: './login.component.scss',
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, ReactiveFormsModule, NotAllowSpaceDirective, RouterLink],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './login.component.html',
  
  animations: [fadeAnimation]
})
export class LoginComponent implements OnInit, OnDestroy {
  /** Injecting required services **/
  private _store = inject(Store);
  private _router = inject(Router);
  private _toastr = inject(ToastrService);
  private _formBuilder = inject(FormBuilder);
  private _cookieService = inject(CookieService);
  private _activatedRoute = inject(ActivatedRoute);
  private _authService = inject(AuthenticationService);
  private _encryptionService = inject(EncryptionService);

  /** Private global variables **/
  private subscriptions: Subscription[] = [];
  // private emailPattern = appSettings.emailPattern;
  protected rememberMe: string = appSettings.rememberKey;

  /** Public global variables **/
  public showType = false;
  public submitted = false;
  public isDisabled = false;
  public loginForm!: FormGroup;
  private redirectTo = '';
  // public currentYear = signal(new Date().getFullYear());

  constructor(private _deepLinkingRoutes: DeepLinkingRoutesService) {}

  /**
   * *Component init life cycle hook
   */
  ngOnInit(): void {
    this.initLoginForm();
    this.onRememberMe();
    this.getQueryParams();
  }

  private getQueryParams() {
    this.subscriptions.push(
      this._activatedRoute.queryParams.subscribe((param) => {
        if (param['enc']) {
          try {
            const decryptData = this._encryptionService.decryptUsingAES256(
              decodeURIComponent(param['enc']),
            );

            if (decryptData && decryptData.redirec_to) {
              this.redirectTo = decryptData.redirec_to;
            } else {
              this._router.navigate(['/login']);
            }
          } catch {
            this._router.navigate(['/login']);
          }
        }
      }),
    );
  }

  /**
   * *Initializing form controls in login form
   */
  private initLoginForm() {
    this.loginForm = this._formBuilder.group({
      username: new FormControl('', [Validators.required]),
      password: new FormControl('', [Validators.required]),
      rememberMe: new FormControl(false)
    });
  }

  /**
   * *Getting all form controls from login form
   */
  get formControl() {
    return this.loginForm.controls;
  }

  /**
   * *Checking if control has error
   *
   * @param field form control name
   * @returns boolean
   */
  public hasFormControlError(field: string): boolean {
    const control = this.loginForm.get(field) as FormControl;
    if (this.submitted && (control.errors || control.invalid)) {
      return true;
    }
    return false;
  }

  /**
   * *If user clicked show password icon
   */
  showPassword(event: Event) {
    event.preventDefault();
    this.showType = !this.showType;
  }

  /**
   * *If user checked Remember Me
   */
  private onRememberMe() {
    let rememberMeData!: IAuthParam;
    const storedData: string = this._cookieService.get(this.rememberMe);

    if (storedData) {
      rememberMeData = this._encryptionService.decryptUsingAES256(storedData);
      //Setting values to login form
      if (rememberMeData) {
        this.loginForm.patchValue({
          username: rememberMeData.username,
          password: rememberMeData.password,
          rememberMe: true
        });
      }
    }
  }

  /**
   * * user login form submit
   */
  public onSubmitLoginForm(): boolean | void {
    if (!this.isDisabled) {
      this.submitted = true;
      const formValue = this.loginForm.getRawValue();
      // stop here if form is invalid
      if (this.loginForm.invalid) {
        this.loginForm.markAllAsTouched();
        return true;
      }

      //form is valid
      this.isDisabled = true;
      const param: ILoginData = {
        username: formValue.username,
        password: formValue.password,
      };

      this.subscriptions.push(
        this._authService
          .authenticate(param, formValue.rememberMe)
          .pipe(
            //After authentication is complete, fetch the profile
            switchMap(() => {
              return this._authService.loginDetails();
            }),
            // Save profile details into state
            switchMap((_loginDetails) => {
              if (_loginDetails !== null) {
                this._store.dispatch(new SetLoginDetails(_loginDetails.response.data));
              }
              return of({
                _profile: _loginDetails.response.data
              });
            }),
          )
          .subscribe({
            next: () => {
              this.submitted = false;
              this.isDisabled = false;
              if (!this.redirectTo) {
                this._router.navigate(['/dashboard']);
              } else {
                this._deepLinkingRoutes.loginRedirectionWithRedirection();
              }
            },
            error: (apiError) => {
              this.submitted = false;
              this.isDisabled = false;
              this._toastr.error(apiError.error.response.status.msg, 'Login Error', {
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
