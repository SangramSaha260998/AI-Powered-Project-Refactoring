interface ILoginDetails {
  name: string;
  email: string;
  user_type: number;
  rolename: string;
  username: string;
  role_id: number;
}

interface IListInfo {
  first: number; // default 0
  sortField: string; // default ''
  sortOrder: number | string; // 0 => nothing, 1 => asc, -1 => desc
  filters: Record<
    string,
    {
      value: string | number;
    }
  >;
  globalFilter: string | number;
  otherObj?: Record<string, any>;
}

interface IFileObj {
  file: File;
  icon?: string;
  progress?: number;
  file_url?: string;
  file_name: string;
  extension?: string;
}

interface IProfileDetails {
  name: string;
  role: string;
  phone: string;
  photo_url: string;
}

interface IHomeListAsPerRole {
  home_id: number;
  home_name: string;
  home_address?: string;
}

interface IAuditTrailListFilters {
  start_date: string;
  end_date: string;
  main_event_id: string;
  sub_event_id: string;
}

interface IAuditTrailListPayload {
  first: number;
  rows: number;
  event_source_id: number;
  filters: IAuditTrailListFilters;
  globalfilter: string;
}

interface IAiReportInfoList {
  report_id: string | number;
  report_name: string;
  report_url?: string;
  [key: string]: unknown;
}

interface IAuditTrailLogDetails {
  main_event: string;
  sub_event: string;
  description: string;
}

interface IAuditTrailListResponse {
  action_by_id: number;
  main_event_id: number;
  sub_event_id: number;
  main_event_name: string;
  sub_event_name: string;
  action_date: string;
  action_by_role_name: string;
  action_by_role_id: number;
  action_by_email: string;
  action_by_name: string;
  log_details: IAuditTrailLogDetails;
}

interface IFetchAllEventsPayload {
  type: number;
  main_event_id: number;
}

interface IFetchAllEventsResponse {
  event_id: number;
  parent_event_id: number;
  event_name: string;
}
