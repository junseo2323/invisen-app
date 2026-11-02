// Outgoing notifications: APNs push to managers' phones, and an optional
// incoming-webhook post (Dooray / Slack style {"text": …}) for the control room.
import { connect, type ClientHttp2Session } from 'node:http2';
import { createSign, createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { q } from './db.js';

export interface PushMessage {
  title: string;
  body: string;
  /** Route to open in the app, e.g. '#log'. */
  route?: string;
  critical?: boolean;
}

let key: KeyObject | null | undefined;
function apnsKey(): KeyObject | null {
  if (key !== undefined) return key;
  const { key: inline, keyFile, keyId, teamId } = config.apns;
  const pem = inline ? inline.replace(/\\n/g, '\n') : keyFile ? readFileSync(keyFile, 'utf8') : null;
  key = pem && keyId && teamId ? createPrivateKey(pem) : null;
  return key;
}

let jwtCache: { token: string; at: number } | null = null;
function apnsJwt(k: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  if (jwtCache && now - jwtCache.at < 50 * 60) return jwtCache.token;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64({ alg: 'ES256', kid: config.apns.keyId })}.${b64({ iss: config.apns.teamId, iat: now })}`;
  const sig = createSign('sha256').update(input).sign({ key: k, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwtCache = { token: `${input}.${sig}`, at: now };
  return jwtCache.token;
}

let session: ClientHttp2Session | null = null;
function apnsSession(): ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) return session;
  session = connect(config.apns.production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com');
  session.on('error', () => (session = null));
  session.unref();
  return session;
}

async function sendApns(token: string, msg: PushMessage): Promise<number> {
  const k = apnsKey();
  if (!k) return 0;
  const payload = JSON.stringify({
    aps: {
      alert: { title: msg.title, body: msg.body },
      sound: msg.critical ? { critical: 1, name: 'default', volume: 1 } : 'default',
      'interruption-level': msg.critical ? 'critical' : 'time-sensitive',
    },
    route: msg.route,
  });
  return new Promise((resolve) => {
    const req = apnsSession().request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${apnsJwt(k)}`,
      'apns-topic': config.apns.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });
    let status = 0;
    req.on('response', (h) => (status = Number(h[':status'])));
    req.on('end', () => resolve(status));
    req.on('error', () => resolve(0));
    req.setTimeout(10_000, () => req.close());
    req.resume();
    req.end(payload);
  });
}

export async function pushToWorkers(workerIds: number[], msg: PushMessage): Promise<number> {
  if (!workerIds.length || !apnsKey()) return 0;
  const tokens = await q<{ token: string }>('select token from push_tokens where worker_id = any($1)', [workerIds]);
  let sent = 0;
  for (const { token } of tokens) {
    const status = await sendApns(token, msg);
    if (status === 200) sent++;
    // 410 Unregistered / 400 BadDeviceToken: forget the token
    if (status === 410 || status === 400) await q('delete from push_tokens where token = $1', [token]);
  }
  return sent;
}

export async function postWebhook(text: string): Promise<boolean> {
  if (!config.alertWebhookUrl) return false;
  try {
    const res = await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, botName: 'invisen' }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Managers responsible for a worker: their direct manager plus site managers. */
export async function managersOf(workerId: number): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `select m.id from workers w
       join workers m on m.active and (m.id = w.manager_id or (m.site_id = w.site_id and m.role = 'manager'))
      where w.id = $1 and m.id <> w.id`,
    [workerId],
  );
  return [...new Set(rows.map((r) => r.id))];
}
