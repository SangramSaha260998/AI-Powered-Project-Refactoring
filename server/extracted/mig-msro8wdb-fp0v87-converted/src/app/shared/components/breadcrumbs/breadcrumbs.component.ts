import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import {
  Component,
  inject,
  Input,
  input,
  OnDestroy,
  OnInit,
  output,
  ViewChild,
} from '@angular/core';
import { GlobalSearchComponent } from '../global-search/global-search.component';
import { EncryptionService } from '@app/core/services';
import { Store } from '@ngxs/store';
import { Subscription } from 'rxjs';
import { AiReportInfoList, AppState } from '@app/store';

interface IButtonConfig {
  icon?: string;
  label: string;
}
interface IBreadcrumbsConfig {
  title: string;
  subTitle?: string;
  icon?: boolean;
  iconRoute?: string | string[] | { path: string | string[]; queryParams?: Record<string, any> };
}

@Component({
  standalone: true,
  selector: 'breadcrumbs',
  imports: [CommonModule, RouterModule],
  templateUrl: './breadcrumbs.component.html',
  styleUrl: './breadcrumbs.component.scss'
})
export class BreadcrumbsComponent implements OnInit, OnDestroy {
  private _store = inject(Store);
  private _router = inject(Router);
  private _encryptService = inject(EncryptionService);
  public openSidebar = output<MouseEvent>();
  public showGlobalSearch = input<boolean>(false);
  public primaryAddButton = input<IButtonConfig>(Object.create(null));
  public breadcrumbsProfile = input<IBreadcrumbsConfig>(Object.create(null));

  // for global search
  public valueChange = output<string>();
  public searchPlaceholder = input<string>('Search');
  public infoIconTooltipData: IAiReportInfoList | undefined = undefined;
  private subscriptions: Subscription[] = [];
  public aiReportInfoList: IAiReportInfoList[] = [];
  @Input() showAiInfoId = 0;
  @ViewChild('globalSearchComponentRef') globalSearchComponentRef!: GlobalSearchComponent;

  private aiReportInfoList$ = this._store.select(AppState.aiReportInfoList);

  ngOnInit(): void {
    if (this.showAiInfoId) {
      this.getAiReportInfoListFromStore();
    }
  }

  // Ai report info list only call for Ai report
  private getAiReportInfoListFromStore(): void {
    this.subscriptions.push(
      this.aiReportInfoList$.subscribe((data) => {
        if (data.length) {
          this.aiReportInfoList = data;
          if (this.showAiInfoId === 9 || this.showAiInfoId === 10) {
            this.infoIconTooltipData = {
              master_ai_report_id: this.showAiInfoId,
              report_main_category: 2,
              report_name: 'Aggression / Choking Events',
              report_description:
                'Residents with care notes indicating physical aggression (e.g., slap, punch, kick) without a corresponding incident form, or any recorded choking incident, should be flagged to the manager.',
            };
          } else if (this.showAiInfoId === 11 || this.showAiInfoId === 12) {
            this.infoIconTooltipData = {
              master_ai_report_id: this.showAiInfoId,
              report_main_category: 2,
              report_name: 'Falls Event',
              report_description:
                'Residents who experienced a fall but either have no corresponding accident form recorded or did not have their risk assessment updated within 24 hours.',
            };
          } else if (this.showAiInfoId === 15 || this.showAiInfoId === 16) {
            this.infoIconTooltipData = {
              master_ai_report_id: this.showAiInfoId,
              report_main_category: 3,
              report_name: 'Resident Data Conflicts',
              report_description:
                'Any new residents who have conflicting information between their care plans, risk assessments, care notes and charts after 48 hours, and then 7 days. To also scan for incorrect name, gender.',
            };
          } else if (this.showAiInfoId === 20) {
            this.infoIconTooltipData = undefined;
          } else {
            this.infoIconTooltipData = this.aiReportInfoList.find(
              (item) => +item.master_ai_report_id === this.showAiInfoId,
            ) || {
              master_ai_report_id: 0,
              report_main_category: 0,
              report_name: '',
              report_description: '',
            };
          }
        } else {
          this.fetchAiReportList();
        }
      }),
    );
  }

  private fetchAiReportList() {
    this.subscriptions.push(
      this._store.dispatch(new AiReportInfoList()).subscribe({
        next: () => this.getAiReportInfoListFromStore()
      }),
    );
  }

  onAddEditClick(event: MouseEvent) {
    this.openSidebar.emit(event);
  }

  onSearchValueChange(value: string) {
    this.valueChange.emit(value);
  }

  onIconClick(): void {
    const profile = this.breadcrumbsProfile();
    const route = profile.iconRoute;

    if (!route) return;

    if (typeof route === 'string' || Array.isArray(route)) {
      this._router.navigate(Array.isArray(route) ? route : [route]);
    } else if (typeof route === 'object' && route.path) {
      this._router.navigate(Array.isArray(route.path) ? route.path : [route.path], {
        queryParams: {
          enc: encodeURIComponent(this._encryptService.encryptUsingAES256(route.queryParams || {})),
        }
      });
    }
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
  }
}
