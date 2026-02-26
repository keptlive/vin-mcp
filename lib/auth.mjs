import crypto from 'node:crypto';

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, SCRYPT_OPTS, (err, key) => {
      if (err) reject(err);
      else resolve({ hash: key.toString('hex'), salt });
    });
  });
}

export function verifyPassword(password, hash, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, SCRYPT_OPTS, (err, key) => {
      if (err) reject(err);
      else resolve(crypto.timingSafeEqual(Buffer.from(hash, 'hex'), key));
    });
  });
}

export function createToken(payload, secret, expiresInSec = 86400) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSec })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    const sigBuf = Buffer.from(sig, 'base64url');
    const expectedBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
