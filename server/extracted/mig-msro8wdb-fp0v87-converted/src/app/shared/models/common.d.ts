interface IDeepLinkingDetails {
  user_type: string;
  route_value: string;
  need_to_login: number;
  route_description?: string;
  route_identification: string | number;
  route_details: Record<string, any>;
}

interface IDropdownOption {
  id?: number | string;
  value?: number | string;
  label?: number | string;
}

type IStringMatchMode =
  | 'startsWith'
  | 'endsWith'
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'notEquals';

type IDateMatchMode = 'dateIs' | 'dateIsNot' | 'dateIsBefore' | 'dateIsAfter';
type INumberMatchMode = 'equals' | 'notEquals' | 'lt' | 'lte' | 'gt' | 'gte';
interface IBespokeInfo {
  id: number;
  image: string;
  information: string;
}

type IPageType = 'add' | 'edit';
interface IFilter {
  value: number | string;
  matchMode: IStringMatchMode | IDateMatchMode | INumberMatchMode;
}
