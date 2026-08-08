interface IRoleListPayload {
  action_id: number;
  first: number;
  rows: number;
  filters: IRoleListFilters;
  globalfilter: string;
}

interface IRoleListFilters {
  is_home_based: number;
  status: number;
}

interface IRoleListResponse {
  role_id: number;
  name: string;
  status: number;
  is_home_based: number;
}
interface IRoleAddEditPayload {
  action_id: number;
  role_id: number;
  name: string;
  status: number;
  is_home_based: number;
}

interface IAdminUsersListPayload {
  action_id: number;
  first: number;
  rows: number;
  globalfilter: string;
  filters: IAdminUsersListFiltersPayload;
}
interface IAdminUsersListFiltersPayload {
  role_id: number | '';
  homes_attached: number | '';
  status: number;
}
interface IAdminUsersListResponse {
  admin_user_id: number;
  username: string;
  first_name: string;
  last_name: string;
  job_title: string;
  role: number;
  role_name: string;
  email: string;
  homes_attached: number[];
  homes_attached_count: string;
  status: number;
  is_logged_in: 0 | 1;
}
interface IAdminUsersListAddEditPayload {
  action_id: number;
  admin_user_id: number;
  first_name: string;
  last_name: string;
  username: string;
  job_title: string;
  role: number;
  role_name?: string;
  email: string;
  status: number;
  homelist: number[];
}
interface IACLResponse {
  menu_id: number;
  main_menu: string;
  value: boolean;
  sub_menu: AclSubMenu[];
  action: IAction[];
}

interface ISubMenu {
  sub_menu_id: number;
  resources_name: string;
  value: boolean;
  action: IAction[];
}

type AclSubMenu = ISubMenu;

interface IAction {
  operation_id: number;
  fk_menu_id: number;
  action_name: string;
  value: boolean;
}
