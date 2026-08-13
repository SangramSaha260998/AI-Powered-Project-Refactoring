interface IIncidentAnalysisDateRangeFilter {
  value1: string;
  value2: string;
  matchMode: 'dateRange';
}

interface IIncidentAnalysisFilters {
  region_id: number[];
  fk_home_id: number[];
  date_range: IIncidentAnalysisDateRangeFilter;
  stack_by?: number;
  is_pre_existing?: 0 | 1 | '';
}

interface IIncidentAnalysisPayload {
  first?: number;
  rows?: number;
  filters: IIncidentAnalysisFilters;
}

/** POST body for reports/feedbackTrendByHome — trend fields are root-level, not inside filters */
interface IFeedbackTrendByHomeRequestPayload {
  action_id?: number;
  trend_type: number;
  /** 1 = Complaint, 2 = Compliment */
  type_id: number;
  /** 1 = concern, 2 = Complaint */
  sub_type_id?: number;
  filters: {
    fk_home_id: number[];
    region_id: number[];
    date_range: IIncidentAnalysisDateRangeFilter;
  };
}

interface IFeedbackProgressiveTrendByHomeRequestPayload {
  action_id?: number;
  trend_type: number;
  /** 1 = Complaint, 2 = Compliment */
  type_id: number;
  /** 1 = concern, 2 = Complaint */
  sub_type_id?: number;
  filters: {
    fk_home_id: number;
    date_range: IIncidentAnalysisDateRangeFilter;
    /** 1=Daily, 2=Weekly, 3=Monthly, 4=Quarterly, 5=Yearly */
    frequency: 1 | 2 | 3 | 4 | 5;
  };
}

interface IIncidentAnalysisHomeItem {
  home_id: number;
  home_name: string;
  event_count: number;
}

interface IIncidentAnalysisItem {
  accident_incident_type_id: number;
  incident_type_name: string;
  incident_count: number;
  homes: IIncidentAnalysisHomeItem[];
}

interface IIncidentAnalysisHome {
  home_id: number;
  home_name: string;
}

interface IIncidentAnalysisResponse {
  reportList: IIncidentAnalysisItem[];
  homeList: IIncidentAnalysisHome[];
  totalCount?: number;
}

interface IIncidentAnalysisAppliedFiltersDisplay {
  homeNames: string;
  regionName: string;
  dateRange: string;
}

interface IIncidentByDayOfWeekDateRangeFilter {
  value1: string;
  value2: string;
  matchMode: 'dateRange';
}

interface IIncidentByDayOfWeekType {
  accident_incident_type_id: number;
  incident_type_name: string;
}

interface IIncidentByDayOfWeekItemIncidentType extends IIncidentByDayOfWeekType {
  incident_count: number;
}

interface IIncidentByDayOfWeekItem {
  day_name: string;
  day_of_week: number;
  incident_types: IIncidentByDayOfWeekItemIncidentType[];
  total_incidents: number;
}

interface IIncidentByDayOfWeekResponse {
  reportList: IIncidentByDayOfWeekItem[];
  totalCount: number;
  incident_type_list: IIncidentByDayOfWeekType[];
}

interface IIncidentByMonthOfYearType {
  accident_incident_type_id: number;
  incident_type_name: string;
}

interface IIncidentByMonthOfYearItemIncidentType extends IIncidentByMonthOfYearType {
  incident_count: number;
}

interface IIncidentByMonthOfYearItem {
  month_name: string;
  month_of_date: number;
  incident_types: IIncidentByMonthOfYearItemIncidentType[];
  total_incidents: number;
}

interface IIncidentByMonthOfYearResponse {
  reportList: IIncidentByMonthOfYearItem[];
  totalCount: number;
  incident_type_list: IIncidentByMonthOfYearType[];
}

interface IIncidentByTimeOfDayItem {
  hour_of_day: number;
  incident_types: {
    accident_incident_type_id: number;
    incident_type_name: string;
    incident_count: number;
  }[];
  total_incidents: number;
}

interface IIncidentByTimeOfDayType {
  accident_incident_type_id: number;
  incident_type_name: string;
  incident_count: number;
}

interface IIncidentByTimeOfDayResponse {
  reportList: IIncidentByTimeOfDayItem[];
  totalCount: number;
  incident_type_list: IIncidentByTimeOfDayType[];
}

// --- Action Plan ---

interface IActionPlanAnalysisHomeItem {
  home_id: number;
  home_name: string;
  event_count: number;
}

interface IActionPlanAnalysisReportItem {
  /**
   * Backend uses `action_category_id` (preferred).
   * `category_id` is kept optional for backward compatibility.
   */
  action_category_id?: number;
  category_id?: number;
  category_name: string;
  action_count: number;
  homes: IActionPlanAnalysisHomeItem[];
}

interface IActionPlanAnalysisHome {
  home_id: number;
  home_name: string;
}

interface IActionPlanAnalysisResponse {
  reportList: IActionPlanAnalysisReportItem[];
  homeList: IActionPlanAnalysisHome[];
  totalCount?: number;
  total_count?: number;
}

interface IActionPlanAppliedFiltersDisplay {
  homeNames: string;
  regionName: string;
  dateRange: string;
}

// --- Serious Incident ---
interface ISeriousIncidentAppliedFiltersDisplay {
  homeNames: string;
  regionName: string;
  dateRange: string;
}

interface ISeriousIncidentAnalysisHomeItem {
  home_id: number;
  home_name: string;
  event_count: number;
}

interface ISeriousIncidentAnalysisReportItem {
  status: number;
  status_id?: number;
  status_name: string;
  incident_count: number;
  homes: ISeriousIncidentAnalysisHomeItem[];
}

interface ISeriousIncidentAnalysisHome {
  home_id: number;
  home_name: string;
}

interface ISeriousIncidentAnalysisResponse {
  reportList: ISeriousIncidentAnalysisReportItem[];
  homeList: ISeriousIncidentAnalysisHome[];
  totalCount?: number;
  total_count?: number;
}

interface ISeriousIncidentsByHomeResidentStatus {
  status: number;
  status_name: string;
}

interface ISeriousIncidentsByHomeResidentReportItemStatus
  extends ISeriousIncidentsByHomeResidentStatus {
  incident_count: number;
}

interface ISeriousIncidentsByHomeResidentReportItem {
  resident_id: number;
  resident_name: string;
  statuses: ISeriousIncidentsByHomeResidentReportItemStatus[];
  total_incidents: number;
}

interface ISeriousIncidentsByHomeResidentResponse {
  reportList: ISeriousIncidentsByHomeResidentReportItem[];
  statuses: ISeriousIncidentsByHomeResidentStatus[];
  totalCount?: number;
  total_count?: number;
}

interface IWoundsAnalysisHomeItem {
  home_id: number;
  home_name: string;
  event_count: number;
}

interface IWoundsAnalysisResponse {
  reportList: IWoundsReportList[];
  homeList: IWoundsAnalysisHome[];
  totalCount?: number;
}

interface IWoundsReportList {
  wound_type_id: number;
  wound_type_name: string;
  wound_count: number;
  homes: IWoundsAnalysisHomeItem[];
}

interface IWoundsAnalysisHome {
  home_id: number;
  home_name: string;
}

// --- Wounds: By Home & Resident ---
interface IWoundsByHomeResidentWoundType {
  wound_type_id: number;
  wound_name: string;
}

interface IWoundsByHomeResidentReportItemWoundType {
  wound_type_id: number;
  wound_type_name: string;
  wound_count: number;
}

interface IWoundsByHomeResidentReportItem {
  resident_name: string;
  resident_id: number;
  wound_types: IWoundsByHomeResidentReportItemWoundType[];
  total_wounds: number;
}

interface IWoundsByHomeResidentResponse {
  reportList: IWoundsByHomeResidentReportItem[];
  totalCount: number;
  wound_types: IWoundsByHomeResidentWoundType[];
}

interface IWoundsSummaryByPeriodFilters {
  region_id: number[];
  fk_home_id: number[];
  /** 3 = Monthly */
  frequency: 3;
  date_range: IIncidentAnalysisDateRangeFilter;
}

interface IWoundsSummaryByPeriodPayload {
  filters: IWoundsSummaryByPeriodFilters;
}

interface IWoundsSummaryByPeriodWoundType {
  wound_type_id: number;
  wound_type_name: string;
}

interface IWoundsSummaryByPeriodReportItemWoundType extends IWoundsSummaryByPeriodWoundType {
  wound_count: number;
}

interface IWoundsSummaryByPeriodReportItem {
  month_name: string;
  month_num: string | number;
  wound_types: IWoundsSummaryByPeriodReportItemWoundType[];
}

interface IWoundsSummaryByPeriodResponse {
  reportList: IWoundsSummaryByPeriodReportItem[];
  totalCount: number;
  woundList: IWoundsSummaryByPeriodWoundType[];
}

interface ISeriousIncidentAppliedFiltersDisplay {
  homeNames: string;
  regionName: string;
  dateRange: string;
}

interface ISeriousIncidentAnalysisReportItem {
  status_id?: number;
  status?: number;
  status_name: string;
  incident_count: number;
  homes?: ISeriousIncidentAnalysisHomeItem[];
}

interface ISeriousIncidentAnalysisResponse {
  reportList: ISeriousIncidentAnalysisReportItem[];
  totalCount?: number;
  total_count?: number;
}

interface ISeriousIncidentsByHomeResidentStatus {
  status_id: number;
  status_name: string;
}

interface ISeriousIncidentsByHomeResidentReportItemStatus
  extends ISeriousIncidentsByHomeResidentStatus {
  incident_count: number;
}

interface ISeriousIncidentsByHomeResidentReportItem {
  resident_id: number;
  resident_name: string;
  statuses: ISeriousIncidentsByHomeResidentReportItemStatus[];
  total_incidents: number;
}

interface ISeriousIncidentsByHomeResidentResponse {
  reportList: ISeriousIncidentsByHomeResidentReportItem[];
  status_list: ISeriousIncidentsByHomeResidentStatus[];
  totalCount?: number;
  total_count?: number;
}

// --- CQC Notifications (Dashboard) ---

interface ICqcNotificationAppliedFiltersDisplay {
  homeNames: string;
  regionName: string;
  dateRange: string;
}

interface ICqcNotificationAnalysisHomeItem {
  home_id: number;
  home_name: string;
  event_count: number;
}

interface ICqcNotificationAnalysisReportItem {
  cqc_count: number;
  cqc_notification_type_id: number;
  cqc_notification_type_name: string;
  homes: ICqcNotificationAnalysisHomeItem[];
}

interface ICqcNotificationAnalysisHome {
  home_id: number;
  home_name: string;
}

/**
 * API sometimes wraps reportList as `{ data: { reportList: [...] } }`
 * so the component normalizes that at runtime.
 */
interface ICqcNotificationAnalysisResponse {
  reportList: ICqcNotificationAnalysisReportItem[];
  homeList: ICqcNotificationAnalysisHome[];
  totalCount?: number;
  total_count?: number;
}

interface ICqcNotificationTypeListItem {
  cqc_notification_type_id: number;
  cqc_notification_type_name: string;
}

interface ICqcNotificationsByResidentReportItemCqcType {
  cqc_notification_type_id: number;
  cqc_notification_type_name: string;
  cqc_count: number;
}

interface ICqcNotificationsByResidentReportItem {
  resident_id: number;
  resident_name: string;
  cqc_types: ICqcNotificationsByResidentReportItemCqcType[];
  total_cqc_count: number;
}

interface ICqcNotificationsByResidentResponse {
  reportList: ICqcNotificationsByResidentReportItem[];
  cqc_type_list: ICqcNotificationTypeListItem[];
  totalCount?: number;
  total_count?: number;
}

interface ICqcAnalysisByPeriodFilters {
  region_id: number[];
  fk_home_id: number[];
  /** 3 = Monthly */
  frequency: 3;
  date_range: IIncidentAnalysisDateRangeFilter;
}

interface ICqcAnalysisByPeriodPayload {
  filters: ICqcAnalysisByPeriodFilters;
}

interface ICqcAnalysisByPeriodCqcType {
  cqc_notification_type_id: string | number;
  cqc_notification_type_name: string;
}

interface ICqcAnalysisByPeriodReportItemCqcType extends ICqcAnalysisByPeriodCqcType {
  cqc_count: number;
}

interface ICqcAnalysisByPeriodReportItem {
  month_name: string;
  month_num: string | number;
  cqc_notification_types: ICqcAnalysisByPeriodReportItemCqcType[];
}

interface ICqcAnalysisByPeriodResponse {
  reportList: ICqcAnalysisByPeriodReportItem[];
  totalCount: number;
  CQCTypeList: ICqcAnalysisByPeriodCqcType[];
}

// --- Pressure Injury ---
interface IPressureInjuryAnalysisReportItem {
  status: number; //not requried
  pressure_injury_category: string;
  injury_count: number;
}
interface IPressureInjuryByHomeResidentReportItem {
  status: number; //not requried
  location_on_body: string;
  injury_count: number;
}
interface IPressureInjuryDayOfTheWeekReportItem {
  day_name: string;
  categories?: IPressureInjuryDayOfTheWeekReportInCategoryItem[];
  locations?: IPressureInjuryDayOfTheWeekReportInLocationItem[];
  total_injuries: number;
}

interface IPressureInjuryLocationCategoryItem {
  pressure_injury_category?: string;
  location_on_body?: string;
}

interface IPressureInjuryDayOfTheWeekReportInCategoryItem {
  pressure_injury_category: string;
  injury_count: number;
}
interface IPressureInjuryDayOfTheWeekReportInLocationItem {
  location_on_body: string;
  injury_count: number;
}

interface IPressureInjuryByMonthReportItem {
  month_name: string;
  year: number;
  month_num: number;
  categories?: IPressureInjuryByMonthReportCategoryItem[];
  locations?: IPressureInjuryDayOfTheWeekReportInLocationItem[];
  total_injuries: number;
}
interface IPressureInjuryByMonthCategoryItem {
  pressure_injury_category: string;
}
interface IPressureInjuryByMonthReportCategoryItem {
  pressure_injury_category: string;
  injury_count: number;
}

interface IPressureInjuryByHomeAndResidentReportItem {
  resident_id: number;
  resident_name: string;
  categories?: IPressureInjuryByHomeAndResidentReportCategoryItem[];
  locations?: IPressureInjuryDayOfTheWeekReportInLocationItem[];
  total_injuries: number;
}

interface IPressureInjuryByHomeAndResidentCategoryItem {
  pressure_injury_category: string;
}
interface IPressureInjuryByHomeAndResidentReportCategoryItem {
  pressure_injury_category: string;
  injury_count: number;
}
interface IPressureInjuryAppliedFiltersDisplay {
  homeNames: string;
  regionName: string;
  dateRange: string;
}

// --- Audits Overdue Trend ---

interface IAuditsOverdueTrendReportItem {
  home_id: number;
  home_name: string;
  audit_count: string | number;
}

interface IAuditsOverdueTrendResponse {
  reportList: IAuditsOverdueTrendReportItem[];
}

// --- Missed Deadline Audit Trends ---
interface IMissedDeadlineAuditTrendRequestPayload {
  trend_type: number;
  filters: {
    fk_home_id: number[];
    region_id: number[];
    date_range: IIncidentAnalysisDateRangeFilter;
  };
}

interface IMissedDeadlineAuditTrendReportItem {
  home_id: string;
  home_name: string;
  bed_name?: string;
  trend_count: string;
}

interface IMissedDeadlineAuditTrendResponse {
  reportList: IMissedDeadlineAuditTrendReportItem[];
}

interface IMissedDeadlineAuditProgressiveTrendRequestPayload {
  trend_type: number;
  filters: {
    fk_home_id: number;
    date_range: IIncidentAnalysisDateRangeFilter;
    frequency: number;
  };
}

interface IMissedDeadlineAuditProgressiveTrendReportItem {
  period: string;
  period_label: string;
  home_id?: string;
  home_name?: string;
  trend_count?: string;
}

interface IMissedDeadlineAuditProgressiveTrendResponse {
  reportList: IMissedDeadlineAuditProgressiveTrendReportItem[];
  avgReportList: IMissedDeadlineAuditProgressiveTrendReportItem[];
}

// --- Non-Compliant Homes ---

interface INonCompliantHomesReportItem {
  home_id: number | string;
  home_name: string;
  audit_count: string | number;
}

interface INonCompliantHomesResponse {
  reportList: INonCompliantHomesReportItem[];
}

// --- Internal & CQC Ratings Trend ---

interface IInternalCqcRatingsTrendPoint {
  overall_rating: number;
  date: string;
  home_id?: number;
  home_name?: string;
}

interface IInternalCqcRatingsTrendResponse {
  internalReportList: IInternalCqcRatingsTrendPoint[];
  CQCReportList: IInternalCqcRatingsTrendPoint[];
}

interface IComplaintByCategoryHomeItem {
  home_id: number;
  home_name: string;
  event_count: number;
}

interface IComplaintByCategoryReportItem {
  category_id: string;
  category_name: string;
  complaint_count: string;
  homes: IComplaintByCategoryHomeItem[];
}

interface IComplaintByCategoryHome {
  home_id: number;
  home_name: string;
}

interface IComplaintByCategoryResponse {
  reportList: IComplaintByCategoryReportItem[];
  homeList: IComplaintByCategoryHome[];
}

interface IFeedbackAnalysisByPeriodFilters {
  /** 1 = Complaint, 2 = Compliment */
  type_id: 1 | 2;
  /** 3 = Monthly */
  frequency: 3;
  region_id: number[];
  fk_home_id: number[];
  date_range: IIncidentAnalysisDateRangeFilter;
}

interface IFeedbackAnalysisByPeriodPayload {
  filters: IFeedbackAnalysisByPeriodFilters;
}

interface IFeedbackAnalysisByPeriodItem {
  item_id: string | number | null;
  item_name: string;
}

interface IFeedbackAnalysisByPeriodReportItemEntry extends IFeedbackAnalysisByPeriodItem {
  item_count: number;
}

interface IFeedbackAnalysisByPeriodReportItem {
  month_name: string;
  month_num: string | number;
  items: IFeedbackAnalysisByPeriodReportItemEntry[];
}

interface IFeedbackAnalysisByPeriodResponse {
  reportList: IFeedbackAnalysisByPeriodReportItem[];
  totalCount: number;
  itemList: IFeedbackAnalysisByPeriodItem[];
}

interface IFeedbackTrendByHomeReportItem {
  home_id: string;
  home_name: string;
  /** Present when trend is bed-based (if API returns it) */
  bed_name?: string;
  complaint_count?: string;
  compliment_count?: string;
}

interface IFeedbackTrendByHomeResponse {
  reportList: IFeedbackTrendByHomeReportItem[];
}

interface IFeedbackProgressiveTrendByHomeReportItem {
  period: string;
  period_label: string;
  home_id?: string;
  home_name?: string;
  complaint_count?: string;
  compliment_count?: string;
}

interface IFeedbackProgressiveTrendByHomeResponse {
  reportList: IFeedbackProgressiveTrendByHomeReportItem[];
  avgReportList: IFeedbackProgressiveTrendByHomeReportItem[];
}

interface IComplimentByHomeReportItem {
  home_id: string;
  home_name: string;
  compliment_count: string;
}

interface IComplimentByHomeResponse {
  reportList: IComplimentByHomeReportItem[];
}

interface ISafeguardingAnalysisHomeItem {
  home_id: number;
  home_name: string;
  event_count: number;
}

interface ISafeguardingAnalysisHome {
  home_id: number;
  home_name: string;
}

interface ISafeguardingAnalysisItem {
  abuse_type_id: number;
  abuse_type_name: string;
  incident_count: number;
  homes: ISafeguardingAnalysisHomeItem[];
}

interface ISafeguardingAnalysisResponse {
  reportList: ISafeguardingAnalysisItem[];
  homeList: ISafeguardingAnalysisHome[];
}

interface ISafeguardingAbuseType {
  abuse_type_id: number;
  abuse_type_name: string;
}

interface ISafeguardingByResidentReportItemAbuseType {
  abuse_type_id: number;
  abuse_type_name: string;
  incident_count: number;
}

interface ISafeguardingByResidentReportItem {
  resident_id: number;
  resident_name: string;
  abuse_types: ISafeguardingByResidentReportItemAbuseType[];
  total_cqc_count: number;
}

interface ISafeguardingByResidentResponse {
  reportList: ISafeguardingByResidentReportItem[];
  abuse_type_list: ISafeguardingAbuseType[];
}

interface ISafeguardingAnalysisPayload {
  filters: {
    region_id: number[];
    fk_home_id: number[];
    date_range: IIncidentAnalysisDateRangeFilter;
  };
}

interface ISafeguardingByResidentPayload {
  filters: {
    fk_home_id: number;
    date_range: IIncidentAnalysisDateRangeFilter;
  };
}

/** 1=>Incidents, 2=>Wounds, 3=>Serious incident, 4=>Pressure Injury, 5=>Pressure Injury-Location on body, 6=>Complaints, 7=>CQC, 8=>Safeguarding */
type IDrillDownReportType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

interface IDrillDownDetailsDateRangeFilter {
  value1: string;
  value2: string;
  matchMode: 'dateRange';
}

interface IDrillDownDetailsFilters {
  region_id: number[];
  fk_home_id: number[];
  date_range: IDrillDownDetailsDateRangeFilter;
  /** 0 = No, 1 = Yes — for report_type 4 and 5 only */
  is_pre_existing?: 0 | 1 | '';
}

interface IDrillDownDetailsPayload {
  report_type: IDrillDownReportType;
  category_id: number | string;
  first?: number;
  rows?: number;
  filters: IDrillDownDetailsFilters;
}

interface IDrillDownDetailsAssigneeItem {
  home_name: string;
  resident_name: string;
  occurance_date: string;
}

interface IDrillDownDetailsResponse {
  assigneeList: IDrillDownDetailsAssigneeItem[];
  total_count: number;
}
