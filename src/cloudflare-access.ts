import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Env } from './types';
import { digest } from './security';

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function accessConfig(env: Env) {
  const domain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.CF_ACCESS_AUD?.trim();
  if (!domain && !audience) return null;
  if (!domain || !audience) throw new HTTPException(503, { message: 'Cloudflare Access is not configured correctly' });
  const issuer = (domain.startsWith('https://') ? domain : 'https://' + domain).replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer)) {
    throw new HTTPException(503, { message: 'Cloudflare Access is not configured correctly' });
  }
  return { issuer, audience };
}

export async function accessConfigHash(env: Env) {
  const config = accessConfig(env);
  return config ? digest(JSON.stringify(config)) : null;
}

export async function accessIdentity(env: Env, token: string | undefined) {
  const config = accessConfig(env);
  if (!config || !token) return null;
  if (!keySets.has(config.issuer)) {
    keySets.set(config.issuer, createRemoteJWKSet(new URL(config.issuer + '/cdn-cgi/access/certs')));
  }
  try {
    const { payload } = await jwtVerify(token, keySets.get(config.issuer)!, {
      issuer: config.issuer, audience: config.audience, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
    });
    const email = z.email().max(254).safeParse(payload.email);
    // Service tokens have no user email and must never become browser accounts.
    if (!email.success || payload.type !== 'app') throw new Error('User application token required');
    return { email: email.data.toLowerCase(), expiresAt: payload.exp! * 1000, configHash: (await accessConfigHash(env))! };
  } catch {
    throw new HTTPException(401, { message: 'Invalid Cloudflare Access identity' });
  }
}
