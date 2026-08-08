import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AuthenticationService {
  getToken(): string {
    return '';
  }

  isAuthenticated(): boolean {
    return false;
  }

  getRefreshToken(): Observable<{ response: { data: Omit<ITokenInfo, 'enc_email'> } }> {
    return of({
      response: {
        data: {
          access_token: '',
          refresh_token: '',
          refresh_token_expire_timestamp: ''
        }
      }
    });
  }

  updateRefreshedToken(_data: Omit<ITokenInfo, 'enc_email'>): void {}

  logout(): void {}
}
