interface IAuthParam {
  username: string;
  password: string;
  login_type: number; // 1 for manual login, 2 for social login
  browser_id: string;
  session_id: string;
  browser_version: string;
  browser_name: string;
  social_id: string;
  social_token: string;
  social_type: string;
}

interface ILoginData {
  username: string;
  password: string;
}

interface IAuthCodeInfo {
  authorization_code: string;
  redirect_url: string;
}

interface ITokenInfo {
  enc_email: string;
  access_token: string;
  refresh_token: string;
  refresh_token_expire_timestamp: string;
}

interface ICreatePasswordParam {
  username: string;
  new_password: string;
  confirm_password: string;
}

interface IVerifyOtpPayload {
  username: string;
  otp: number;
}
