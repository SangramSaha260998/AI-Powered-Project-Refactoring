import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class SocketIoService {
  reconnectWithLatestToken(): void {}
  disconnect(): void {}
  clearConversationState(): void {}
}
