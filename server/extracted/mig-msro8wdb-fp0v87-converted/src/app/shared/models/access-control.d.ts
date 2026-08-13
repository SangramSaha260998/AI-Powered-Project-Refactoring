interface IRoleAddEditParam {
  role_id: string;
  name: string;
  status: boolean;
}

interface IDepartmentAndRoleListParam {
  globalSearch: string;
  no_of_employee: INoOfEmpIFilterloyee;
}
interface IDepartmentAddEditParam {
  department_id: string;
  name: string;
  status: boolean;
}
interface IDepartmentAndRoleList {
  id: string;
  name: string;
  no_of_employee: number;
  status: boolean;
}

interface IMainMenu {
  value: boolean;
  action: Action[];
  main_menu_id: number;
  sub_menu: SubMenu[];
  main_menu: string;
}

interface IACLAction {
  operation_id: number;
  value: boolean;
}

interface IACLSubMenu {
  sub_menu_id: number;
  value: boolean;
  action: IACLAction[];
}

interface IACLResponse {
  menu_id: number | string;
  main_menu_id: number;
  main_menu: string;
  value: boolean;
  action: IACLAction[];
  sub_menu: IACLSubMenu[];
}
