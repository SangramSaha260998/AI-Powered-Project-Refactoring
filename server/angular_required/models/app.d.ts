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

interface IFetchAllEventsPayload {
  type: number;
  main_event_id: number;
}

interface IFetchAllEventsResponse {
  event_id: number;
  parent_event_id: number;
  event_name: string;
}
