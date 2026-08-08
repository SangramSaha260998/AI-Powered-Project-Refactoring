/* eslint-disable @typescript-eslint/prefer-for-of */
import { Subscription } from 'rxjs';
import { appSettings } from '@app/config';
import { CommonService } from '@app/core/services/common.service';
import { Input, Directive, OnDestroy, ElementRef } from '@angular/core';

@Directive({
  selector: '[accessControl]',
  standalone: true,
})
export class AccessControlDirective implements OnDestroy {
  private actionID!: number | string;
  private actionIDS: number[] = [];
  private moduleID!: number | string;
  private submoduleID!: number | string;
  private allIdAccess: boolean[] = [];
  private accessControls: IACLResponse[] = [];
  private subscriptions: Subscription[] = [];
  private credentials: string = appSettings.credentialsKey;
  @Input() set moduleId(value: number | string) {
    if (value !== undefined) {
      this.moduleID = value;
      this.fetchAccessControl();
    }
  }
  @Input() set actionIds(value: number[]) {
    if (value !== undefined) {
      this.actionIDS = value;
      this.fetchAccessControl();
    }
  }
  @Input() set actionId(value: number | string) {
    if (value !== undefined) {
      this.actionID = value;
      this.fetchAccessControl();
    }
  }
  @Input() set submoduleId(value: number | string) {
    if (value !== undefined) {
      this.submoduleID = value;
      this.fetchAccessControl();
    }
  }
  constructor(
    private _common: CommonService,
    private elementRef: ElementRef,
  ) {}
  fetchAccessControl() {
    this.subscriptions.push(
      this._common.accessControls$.subscribe((data) => {
        if (data) {
          this.accessControls = data;
          if (this.accessControls && this.accessControls.length) {
            this.checkAccess();
          }
        }
      }),
    );
    // Message broadcast channel
    this._common.aclBroadcastChannel.onmessage = (event) => {
      const data = event.data;
      if (data) {
        this._common.setAccessControls(data, false);
      }
    };
  }
  checkAccess() {
    let checkModule;
    if (this.moduleID) {
      for (let i = 0; i < this.accessControls.length; i++) {
        if (this.accessControls[i].menu_id == this.moduleID) {
          checkModule = this.accessControls[i];
          break;
        }
      }
    } else if (this.submoduleID) {
      for (let i = 0; i < this.accessControls.length; i++) {
        if (this.accessControls[i].sub_menu.length) {
          for (let j = 0; j < this.accessControls[i].sub_menu.length; j++) {
            if (this.accessControls[i].sub_menu[j].sub_menu_id == this.submoduleID) {
              checkModule = this.accessControls[i].sub_menu[j];
              break;
            }
          }
        } else {
          // eslint-disable-next-line @typescript-eslint/prefer-for-of
          for (let k = 0; k < this.accessControls[i].action.length; k++) {
            if (this.accessControls[i].action[k].operation_id == this.submoduleID) {
              checkModule = this.accessControls[i].action[k];
              break;
            }
          }
        }
      }
    } else if (this.actionIDS.length) {
      for (let l = 0; l < this.actionIDS.length; l++) {
        for (let i = 0; i < this.accessControls.length; i++) {
          if (this.accessControls[i].sub_menu.length) {
            for (let j = 0; j < this.accessControls[i].sub_menu.length; j++) {
              if (this.accessControls[i].sub_menu[j].action.length) {
                for (let k = 0; k < this.accessControls[i].sub_menu[j].action.length; k++) {
                  if (
                    this.accessControls[i].sub_menu[j].action[k].operation_id == this.actionIDS[l]
                  ) {
                    checkModule = this.accessControls[i].sub_menu[j].action[k];
                    break;
                  }
                }
              }
            }
          }
          // if (this.accessControls[i].action.length) {
          //   for (let j = 0; j < this.accessControls[i].action.length; j++) {
          //     if (this.accessControls[i].action[j].operation_id == this.actionIDS[l]) {
          //       checkModule = this.accessControls[i].action[j];
          //     }
          //   }
          // }
        }
        if (checkModule) this.allIdAccess.push(checkModule.value);
      }
    } else if (this.actionID) {
      for (let i = 0; i < this.accessControls.length; i++) {
        if (this.accessControls[i].sub_menu.length) {
          for (let j = 0; j < this.accessControls[i].sub_menu.length; j++) {
            if (this.accessControls[i].sub_menu[j].action.length) {
              for (let k = 0; k < this.accessControls[i].sub_menu[j].action.length; k++) {
                if (this.accessControls[i].sub_menu[j].action[k].operation_id == this.actionID) {
                  checkModule = this.accessControls[i].sub_menu[j].action[k];
                  break;
                }
              }
            }
          }
        }
        // if (this.accessControls[i].action.length) {
        //   for (let j = 0; j < this.accessControls[i].action.length; j++) {
        //     if (this.accessControls[i].action[j].operation_id == this.actionID) {
        //       checkModule = this.accessControls[i].action[j];
        //     }
        //   }
        // }
      }
    }
    // handle visibility of the element
    if (checkModule) {
      if (this.elementRef.nativeElement.style) {
        this.elementRef.nativeElement.style.opacity = checkModule.value === true ? '1' : '0';
      }
      if (this.elementRef.nativeElement.style)
        this.elementRef.nativeElement.style.display = checkModule.value === true ? '' : 'none';
    }
    if (this.allIdAccess.length) {
      const isShowInMenu = this.allIdAccess.every((item) => item === false);
      if (this.elementRef.nativeElement.style) {
        this.elementRef.nativeElement.style.opacity = !isShowInMenu === true ? '1' : '0';
      }
      if (this.elementRef.nativeElement.style)
        this.elementRef.nativeElement.style.display = !isShowInMenu === true ? '' : 'none';
      this.allIdAccess = [];
    }
  }
  ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
  }
}
