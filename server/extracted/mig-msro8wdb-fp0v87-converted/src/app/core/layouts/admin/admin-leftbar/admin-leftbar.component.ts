import { CommonModule } from '@angular/common';
import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { NavigationEnd, Router, RouterModule, RouterLink } from '@angular/router';
import { fadeAnimation, slideInOut } from '@app/shared/animations';
import { AccessControlDirective } from '@app/shared/directives/access-control.directive';
import { GenerateSvgSpritePipe } from '@app/shared/pipes/icon-transform.pipe';
import { getPathFromUrl } from '@app/shared/utilities';
import { Subscription } from 'rxjs';

@Component({
  styleUrl: './admin-leftbar.component.scss',
  selector: 'admin-leftbar',
  standalone: true,
  imports: [CommonModule, RouterModule, AccessControlDirective, GenerateSvgSpritePipe, RouterLink],
  templateUrl: './admin-leftbar.component.html',
  
  animations: [slideInOut, fadeAnimation]
})
export class AdminLeftbarComponent implements OnInit, OnDestroy {
  menu: any = null;
  submenu: any = null;

  private _router = inject(Router);

  public overlayTop = 0;
  private currentURL = '';
  public menus: IMenu[] = [];
  public isSidebarOpen = false;
  public isMessagePage = false;
  private subscriptions: Subscription[] = [];
  public currentYear = new Date().getFullYear();

  constructor() {
    this.getMenus();
    this.getRoute();
  }

  ngOnInit(): void {
    const adminWrapperEl = document.querySelector('.admin-layout-container') as HTMLElement;
    let previousRoute = this._router.url;

    if (this._router.url === '/trand') {
      this.isSidebarOpen = false;
      adminWrapperEl?.classList.add('sidebar-collapse');
    }

    // 👇 Sidebar remain small on page load
    if (window.innerWidth <= 1199) {
      this.isSidebarOpen = false;
      adminWrapperEl?.classList.add('sidebar-collapse');
    }
    // 👇 Sidebar small on route change
    this._router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        const currentRoute = event.urlAfterRedirects;

        if (window.innerWidth <= 1199 || currentRoute === '/trand') {
          this.isSidebarOpen = false;
          adminWrapperEl?.classList.add('sidebar-collapse');
        } else if (previousRoute === '/trand' && window.innerWidth > 1199) {
          this.isSidebarOpen = true;
          adminWrapperEl?.classList.remove('sidebar-collapse');
        }

        previousRoute = currentRoute;
      }
    });
  }

  // Position overlay block slightly below the menu item, accounting for scroll
  showOverlay(event: MouseEvent) {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();

    this.overlayTop = rect.top + 42 + window.scrollY;
  }

  /**
   * *Getting Current Route and setting as active
   */
  getMenus() {
    this.menus = [
      {
        id: 1000,
        ids: [],
        label: 'Dashboard',
        icon: 'icon-dashboard',
        isActive: false,
        URl: '/dashboard',
        isSubMenuOpen: false,
        subMenus: [],
      },
    ];
  }

  /**
   * * Getting Current Route and setting as active
   */
  getRoute() {
    this.subscriptions.push(
      this._router.events.subscribe((event) => {
        if (event instanceof NavigationEnd) {
          const URL = event.url;
          const convertedURL = getPathFromUrl(URL);
          this.currentURL = convertedURL;
          const urlArray = convertedURL.split('/').filter((item) => item !== '');

          const primaryMenu = urlArray[0];
          const secondaryMenu = urlArray.slice(1, urlArray.length).join('/');
          for (const menus of this.menus) {
            // set or reset left sidebar main-menu selection
            const menuPrimarySegment = menus.URl.split('/').filter((item) => item !== '')[0];
            const hasSubMenuWithPrimarySegment = menus.subMenus.some(
              (subMenus) =>
                subMenus.URl.split('/').filter((item) => item !== '')[0] === primaryMenu,
            );
            if (
              (menus.subMenus.length === 0 &&
                menus.URl ===
                  (secondaryMenu ? `/${primaryMenu}/${secondaryMenu}` : `/${primaryMenu}`)) ||
              menuPrimarySegment === primaryMenu ||
              hasSubMenuWithPrimarySegment
            ) {
              menus.isActive = true;
              menus.isSubMenuOpen = true;
            } else {
              menus.isActive = false;
              menus.isSubMenuOpen = false;
            }

            if (menus.subMenus.length > 0) {
              // set / reset left sidebar main-menu and submenu selection
              for (const subMenus of menus.subMenus) {
                if (convertedURL === subMenus.URl || convertedURL.startsWith(`${subMenus.URl}/`)) {
                  menus.isActive = true;
                  subMenus.isActive = true;
                  menus.isSubMenuOpen = true;
                } else {
                  subMenus.isActive = false;
                }
              }
            }
          }
        }
      }),
    );
  }

  /**
   * *Getting Toggle Dropdown Menu
   */
  toggleSubMenu(menuID: number, event?: Event) {
    if (event) {
      event.preventDefault();
    }
    this.menus.forEach((menu) => {
      if (menu.id === menuID) {
        menu.isSubMenuOpen = !menu.isSubMenuOpen;
      } else {
        menu.isSubMenuOpen = false;
      }
    });
  }

  /**
   * *Routing
   */
  routeToLink(route: string, isActive: boolean) {
    if (route == 'javascript:void(0)') {
      return;
    }
    if (isActive && this.currentURL === route) {
      return;
    }
    this._router.navigate([route]);
  }

  /**
   * *Admin Toggle Menu
   */
  toggleSidebar(event: Event) {
    event.preventDefault();
    const adminWrapperEl = document.querySelector('.admin-layout-container') as HTMLElement;

    if (window.innerWidth <= 1199) {
      this.isSidebarOpen = !this.isSidebarOpen;
      if (this.isSidebarOpen) {
        adminWrapperEl?.classList.remove('sidebar-collapse');
      } else {
        adminWrapperEl?.classList.add('sidebar-collapse');
      }
    } else {
      this.isSidebarOpen = !this.isSidebarOpen;
      if (adminWrapperEl?.classList.contains('sidebar-collapse')) {
        adminWrapperEl?.classList.remove('sidebar-collapse');
      } else {
        adminWrapperEl?.classList.add('sidebar-collapse');
      }
    }
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
  }

  /**
   * * Getting Current Route and setting as active
   */
  // getRoute() {
  //   this.subscriptions.push(
  //     this._router.events.subscribe((event) => {
  //       if (event instanceof NavigationEnd) {
  //         const URL = event.url;
  //         const convertedURL = getPathFromUrl(URL);
  //         this.currentURL = convertedURL;
  //         const urlArray = convertedURL.split('/').filter((item) => item !== '');

  //         const primaryMenu = urlArray[0];
  //         const secondaryMenu = urlArray.slice(1, urlArray.length).join('/');
  //         for (const menus of this.menus) {
  //           // set or reset left sidebar main-menu selection
  //           if (
  //             (menus.subMenus.length === 0 &&
  //               menus.URl ===
  //                 (secondaryMenu ? `/${primaryMenu}/${secondaryMenu}` : `/${primaryMenu}`)) ||
  //             menus.URl.split('/').filter((item) => item !== '')[0] === primaryMenu
  //           ) {
  //             menus.isActive = true;
  //             menus.isSubMenuOpen = true;
  //           } else {
  //             menus.isActive = false;
  //             menus.isSubMenuOpen = false;
  //           }

  //           if (menus.subMenus.length > 0) {
  //             // set / reset left sidebar main-menu and submenu selection
  //             for (const subMenus of menus.subMenus) {
  //               if (
  //                 subMenus.URl ==
  //                 (secondaryMenu ? `/${primaryMenu}/${secondaryMenu}` : `/${primaryMenu}`)
  //               ) {
  //                 menus.isActive = true;
  //                 subMenus.isActive = true;
  //                 menus.isSubMenuOpen = true;
  //               } else {
  //                 subMenus.isActive = false;
  //               }
  //             }
  //           }
  //         }
  //       }
  //     }),
  //   );
  // }
}
