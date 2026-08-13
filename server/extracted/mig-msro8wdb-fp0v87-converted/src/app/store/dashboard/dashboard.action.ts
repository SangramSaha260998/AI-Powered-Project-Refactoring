export class FetchDrillDownDetails {
  static readonly type = '[FetchDrillDownDetails] Post';
  constructor(
    public param: IDrillDownDetailsPayload,
    public showLoader = true,
  ) {}
}
