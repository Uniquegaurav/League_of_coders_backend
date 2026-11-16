import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { unauthorized } from '../utils/http.js';

export const signToken = (user) =>
  jwt.sign({ id: user._id.toString() }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

export const verifyToken = (token) => {
  try {
    return jwt.verify(token, config.jwtSecret).id;
  } catch {
    return null;
  }
};

const readToken = (req) => {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
};

export const optionalAuth = (req, _res, next) => {
  const token = readToken(req);
  req.userId = token ? verifyToken(token) : null;
  next();
};

export const requireAuth = (req, _res, next) => {
  const token = readToken(req);
  const userId = token && verifyToken(token);
  if (!userId) return next(unauthorized());
  req.userId = userId;
  next();
};
