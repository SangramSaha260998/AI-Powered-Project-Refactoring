import { Subscription } from 'rxjs';
// import { CommonService } from './common.service';
import { Injectable, OnDestroy } from '@angular/core';
import { CommonService } from './common.service';

@Injectable({ providedIn: 'root' })
export class AclService implements OnDestroy {
  private allIdAccess: boolean[] = [];
  private subscriptions: Subscription[] = [];
  private accessControls: any[] = [];

  constructor(private _common: CommonService) {
    this.subscriptions.push(
      this._common.accessControls$.subscribe((data) => {
        if (data) {
          this.accessControls = data;
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

  public hasAccess(arg: {
    moduleId?: string | number;
    actionId?: string | number;
    actionIds?: string[] | number[];
    submoduleId?: string | number;
  }): boolean {
    let checkModule;
    if (arg.moduleId) {
      for (const control of this.accessControls) {
        if (control.menu_id == arg.moduleId) {
          checkModule = control;
          break;
        }
      }
    } else if (arg.submoduleId) {
      for (const control of this.accessControls) {
        if (control.sub_menu.length) {
          for (const subMenu of control.sub_menu) {
            if (subMenu.sub_menu_id == arg.submoduleId) {
              checkModule = subMenu;
              break;
            }
          }
        } else {
          for (const action of control.action) {
            if (action.operation_id == arg.submoduleId) {
              checkModule = action;
              break;
            }
          }
        }
      }
    } else if (arg.actionIds && arg.actionIds.length) {
      for (const actionId of arg.actionIds) {
        for (const control of this.accessControls) {
          if (control.sub_menu.length) {
            for (const subMenu of control.sub_menu) {
              if (subMenu.action.length) {
                for (const action of subMenu.action) {
                  if (action.operation_id == actionId) {
                    checkModule = action;
                    break;
                  }
                }
              }
            }
          }
        }
        if (checkModule) this.allIdAccess.push(checkModule.value);
      }
    } else if (arg.actionId) {
      for (const control of this.accessControls) {
        if (control.sub_menu.length) {
          for (const subMenu of control.sub_menu) {
            if (subMenu.action.length) {
              for (const action of subMenu.action) {
                if (action.operation_id == arg.actionId) {
                  checkModule = action;
                  break;
                }
              }
            }
          }
        }
      }
    }
    if (checkModule) {
      if (checkModule.value === true) {
        return true;
      } else {
        return false;
      }
    }

    if (this.allIdAccess.length) {
      const isShowInMenu = this.allIdAccess.every((item) => item === false);
      if (!isShowInMenu) {
        return true;
      } else {
        return false;
      }
    }

    return false;
  }

  ngOnDestroy(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
  }
}
