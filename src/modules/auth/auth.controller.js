import * as authService from './auth.service.js';

// Controllers only deal with HTTP. Business logic lives in the service.
export const register = async (req, res) => {
  const data = await authService.register(req.body);
  res.status(201).json({ success: true, data });
};

export const login = async (req, res) => {
  const data = await authService.login(req.body);
  res.json({ success: true, data });
};

export const refresh = async (req, res) => {
  const data = await authService.refresh(req.body.refreshToken);
  res.json({ success: true, data });
};

export const logout = async (req, res) => {
  await authService.logout(req.body.refreshToken);
  res.json({ success: true, data: { message: 'Logged out' } });
};

export const me = async (req, res) => {
  const data = await authService.getMe(req.user.id);
  res.json({ success: true, data });
};

//change password

export const changePassword = async (req, res) => {
  await authService.changePassword(req.user.id, req.body);
  res.json({ success: true, data: { message: 'Password changed. Please log in again.' } });
};