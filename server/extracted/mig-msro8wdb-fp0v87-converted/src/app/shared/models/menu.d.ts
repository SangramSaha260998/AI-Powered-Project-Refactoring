interface IMenu {
  id: number;
  ids: number[];
  URl: string;
  icon: string;
  label: string;
  isActive: boolean;
  isSubMenuOpen: boolean;
  subMenus: IMenu[];
}
