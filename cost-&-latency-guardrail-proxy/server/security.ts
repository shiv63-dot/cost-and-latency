import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from './config.ts';
import type { ProxyDatabase } from './database.ts';

const EPHEMERAL_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

function getSessionSecret(): string {
  return process.env.SESSION_SECRET?.trim() || EPHEMERAL_SESSION_SECRET;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, originalHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const original = Buffer.from(originalHex, 'hex');
  if (derived.length !== original.length) return false;
  return crypto.timingSafeEqual(derived, original);
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export interface SessionPayload {
  sub: string;
  role: 'admin';
  exp: number;
}

export function createSessionToken(sub = 'admin', ttlSeconds = 43200): string {
  const payload: SessionPayload = {
    sub,
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, providedSig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(encoded)
    .digest('base64url');

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    if (parsed.role !== 'admin') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isAdminConfigured(db: ProxyDatabase, config: AppConfig): boolean {
  if (config.adminPasscode.length > 0) return true;
  const row = db.db.prepare('SELECT id FROM admin_auth WHERE id = 1').get();
  return Boolean(row);
}

export function verifyAdminCredential(
  db: ProxyDatabase,
  config: AppConfig,
  passcode: string
): boolean {
  if (!passcode) return false;
  if (config.adminPasscode.length > 0) {
    const a = Buffer.from(passcode);
    const b = Buffer.from(config.adminPasscode);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const row = db.db
    .prepare('SELECT password_hash FROM admin_auth WHERE id = 1')
    .get() as { password_hash: string } | undefined;
  if (!row) return false;
  return verifyPassword(passcode, row.password_hash);
}

export function extractBearerOrApiKey(req: Request): string {
  const xApiKey = req.header('x-api-key')?.trim();
  if (xApiKey) return xApiKey;
  const auth = req.header('authorization')?.trim() || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerOrApiKey(req);
  if (!token) {
    res.status(401).json({
      error: {
        message: 'Admin authentication required. Sign in to perform administrative actions.',
        type: 'authentication_error',
        code: 'admin_auth_required',
      },
    });
    return;
  }
  const session = verifySessionToken(token);
  if (!session) {
    res.status(403).json({
      error: {
        message: 'Invalid or expired admin session token.',
        type: 'authorization_error',
        code: 'invalid_admin_token',
      },
    });
    return;
  }
  (req as Request & { adminSession?: SessionPayload }).adminSession = session;
  next();
}

export interface AuthenticatedClient {
  clientId: string;
  rpmLimit?: number;
  authMode: 'api_key' | 'admin_session';
}

export function authenticateGatewayClient(
  db: ProxyDatabase,
  config: AppConfig,
  req: Request
): AuthenticatedClient | null {
  const token = extractBearerOrApiKey(req);
  if (!token) return null;

  // 1. Check valid admin session token (used by authenticated dashboard playground)
  const session = verifySessionToken(token);
  if (session) {
    const requestedClient = req.header('x-client-id')?.trim();
    return {
      clientId: requestedClient ? requestedClient.slice(0, 64) : 'dashboard-operator',
      authMode: 'admin_session',
    };
  }

  // 2. Check environment-configured client API key
  if (config.proxyClientApiKey.length > 0) {
    const a = Buffer.from(token);
    const b = Buffer.from(config.proxyClientApiKey);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      const requestedClient = req.header('x-client-id')?.trim();
      return {
        clientId: requestedClient ? requestedClient.slice(0, 64) : 'default-client',
        authMode: 'api_key',
      };
    }
  }

  // 3. Check SQLite-stored client keys (hashed with SHA-256)
  const hash = sha256Hex(token);
  const keyRow = db.db
    .prepare('SELECT id, client_id, rpm_limit, enabled FROM client_keys WHERE key_hash = ?')
    .get(hash) as
    | { id: number; client_id: string; rpm_limit: number; enabled: number }
    | undefined;

  if (keyRow && keyRow.enabled === 1) {
    db.db
      .prepare('UPDATE client_keys SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), keyRow.id);
    return {
      clientId: keyRow.client_id,
      rpmLimit: keyRow.rpm_limit,
      authMode: 'api_key',
    };
  }

  return null;
}

export function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('169.254.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
