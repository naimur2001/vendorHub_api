import * as authService from './auth.service.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

export const REFRESH_COOKIE = 'vh_refresh';

// The session cookie: invisible to JavaScript, only sent to the auth endpoints, HTTPS-only in production.
function cookieOptions() {
  const sameSite = env.COOKIE_SAMESITE;
  const secure = sameSite === 'none' ? true : (env.COOKIE_SECURE ?? env.NODE_ENV === 'production');
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: '/api/v1/auth',
    maxAge: env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
    ...(env.COOKIE_DOMAIN && { domain: env.COOKIE_DOMAIN }),
  };
}

// The website and the app wrappers ask for cookie mode with this header.
const wantsCookie = (req) => req.get('X-Auth-Mode') === 'cookie';

// Cookie mode: the refresh token goes into the httpOnly cookie and is left OUT of the JSON.
// Without the header (native apps, scripts) the JSON stays exactly as before.
function sendSession(res, status, data, cookieMode) {
  if (!cookieMode) return res.status(status).json({ success: true, data });
  res.cookie(REFRESH_COOKIE, data.refreshToken, cookieOptions());
  const { refreshToken, ...rest } = data;
  return res.status(status).json({ success: true, data: rest });
}

// Where the refresh token comes from: the JSON body, or the cookie. The cookie only counts together
// with the X-Auth-Mode header, which another website cannot add without our CORS permission (blocks CSRF).
function readRefreshToken(req) {
  if (req.body?.refreshToken) return { token: req.body.refreshToken, fromCookie: false };
  const cookie = req.cookies?.[REFRESH_COOKIE];
  if (cookie) {
    if (!wantsCookie(req)) {
      throw new AppError(403, 'Send the header "X-Auth-Mode: cookie" to use the session cookie');
    }
    return { token: cookie, fromCookie: true };
  }
  return { token: null, fromCookie: false };
}

function clearSessionCookie(res) {
  const { maxAge, ...options } = cookieOptions();
  res.clearCookie(REFRESH_COOKIE, options);
}

// Controllers only deal with HTTP. Business logic lives in the service.
export const register = async (req, res) => {
  sendSession(res, 201, await authService.register(req.body), wantsCookie(req));
};

export const login = async (req, res) => {
  sendSession(res, 200, await authService.login(req.body), wantsCookie(req));
};

export const refresh = async (req, res) => {
  const { token, fromCookie } = readRefreshToken(req);
  if (!token) throw new AppError(401, 'Invalid refresh token');
  try {
    sendSession(res, 200, await authService.refresh(token), fromCookie || wantsCookie(req));
  } catch (err) {
    if (fromCookie) clearSessionCookie(res); // a dead cookie is removed, so the website shows the login page
    throw err;
  }
};

export const logout = async (req, res) => {
  const { token } = readRefreshToken(req);
  if (token) await authService.logout(token);
  clearSessionCookie(res);
  res.json({ success: true, data: { message: 'Logged out' } });
};

export const me = async (req, res) => {
  const data = await authService.getMe(req.user.id);
  res.json({ success: true, data });
};

export const changePassword = async (req, res) => {
  await authService.changePassword(req.user.id, req.body);
  clearSessionCookie(res); // all sessions were revoked; the cookie is useless now
  res.json({ success: true, data: { message: 'Password changed. Please log in again.' } });
};

export const forgotPassword = async (req, res) => {
  await authService.forgotPassword(req.body);
  res.json({ success: true, data: { message: 'If that email is registered, a reset link has been sent.' } });
};

export const resetPassword = async (req, res) => {
  await authService.resetPassword(req.body);
  res.json({ success: true, data: { message: 'Password updated. Please log in with your new password.' } });
};