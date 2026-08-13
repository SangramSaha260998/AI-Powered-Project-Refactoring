export class SetLoginDetails {
  static readonly type = '[SetLoginDetails] Set';
  constructor(public payload: ILoginDetails) {}
}
export class ProfileDetails {
  static readonly type = '[profileDetails] Post';
}
export class EditProfile {
  static readonly type = '[EditProfile] Post';
  constructor(public payload: { first_name: string; last_name: string }) {}
}

export class DeleteProfileImage {
  static readonly type = '[DeleteProfileImage] POST';
}

export class FetchHomeListAsPerRole {
  static readonly type = '[FetchHomeListAsPerRole] Post';
}

export class GetAuditTrailList {
  static readonly type = '[GetAuditTrailList] Post';
  constructor(public payload: IAuditTrailListPayload) {}
}

export class GetAllEventsList {
  static readonly type = '[GetAllEventsList] Post';
  constructor(public payload: IFetchAllEventsPayload) {}
}

export class AiReportInfoList {
  static readonly type = '[AiReportInfoList] Post';
}
