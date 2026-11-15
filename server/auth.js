// Optional password protection. Active when ANKI_REA_PASSWORD is set (always do this online).
// The session cookie is an HMAC of a fixed label, so it is stateless (works on serverless hosting)
// and becomes invalid as soon as the password or ANKI_REA_SECRET changes.
import crypto from 'node:crypto';

const COOKIE = 'rea_session';
const ONE_YEAR = 365 * 24 * 3600;

export function createAuth({ password = process.env.ANKI_REA_PASSWORD || '', secret = process.env.ANKI_REA_SECRET || '' } = {}) {
  const enabled = password.length > 0;
  const key = crypto.createHash('sha256').update(`${secret}\u0000${password}`).digest();
  const token = crypto.createHmac('sha256', key).update('anki-rea-session-v1').digest('base64url');

  const same = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  function readCookie(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return '';
  }

  const secure = (req) => (req.headers['x-forwarded-proto'] || '').includes('https') || req.socket?.encrypted;

  return {
    enabled,
    isAuthenticated: (req) => !enabled || same(readCookie(req), token),
    checkPassword: (input) => enabled && same(crypto.createHash('sha256').update(String(input)).digest(), crypto.createHash('sha256').update(password).digest()),
    loginCookie: (req) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ONE_YEAR}${secure(req) ? '; Secure' : ''}`,
    logoutCookie: (req) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? '; Secure' : ''}`,
  };
}
