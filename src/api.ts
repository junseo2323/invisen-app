// Typed client for the invisen API (server/src/api-types.ts is the contract).
import type * as T from '../server/src/api-types';
import { ApiError } from './errors';
import { demoApi } from './demo/fake-api';

export { ApiError };

/** '' = same origin (web, or the iOS app loading the hosted site).
 *  The iOS app with the bundled build needs the absolute server URL: VITE_API_URL=https://<domain>. */
const BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/$/, '');

let token: string | null = null;
let onUnauthorized: () => void = () => {};
export const setToken = (t: string | null) => (token = t);
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

async function req<R>(method: string, path: string, body?: unknown): Promise<R> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(0, 'network', '인터넷 연결을 확인해 주세요.');
  }
  if (res.status === 204) return undefined as R;
  const data = (await res.json().catch(() => null)) as (R & Partial<T.ApiError>) | null;
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? '잠시 문제가 생겼어요. 다시 시도해 주세요.');
  }
  return data as R;
}

const httpApi = {
  login: (phone: string, code: string) => req<T.LoginResponse>('POST', '/api/auth/login', { phone, code }),
  logout: () => req<void>('POST', '/api/auth/logout'),
  me: () => req<T.Me>('GET', '/api/me'),
  status: () => req<T.Status>('GET', '/api/me/status'),
  exposure: () => req<T.Exposure>('GET', '/api/me/exposure'),
  events: () => req<T.LogDay>('GET', '/api/me/events'),
  site: () => req<T.Site>('GET', '/api/site'),
  sensorLive: () => req<T.SensorLive>('GET', '/api/sensor/live'),
  pairSensor: (sensorId: string) => req<T.SensorInfo>('PUT', '/api/me/sensor', { sensorId }),
  testSensors: () => req<T.TestSensor[]>('GET', '/api/me/test-sensors'),
  pushToken: (token: string) => req<void>('PUT', '/api/me/push-token', { token, platform: 'ios' }),
  postReadings: (body: T.ReadingsRequest) => req<T.ReadingsResponse>('POST', '/api/readings', body),
  sos: (body: T.SosRequest) => req<T.SosResponse>('POST', '/api/sos', body),
  cancelSos: (id: number) => req<void>('POST', `/api/sos/${id}/cancel`),
  requestShift: () => req<{ notified: string[] }>('POST', '/api/me/requests', { type: 'shift' }),
  ackAlert: () => req<void>('POST', '/api/me/alerts/ack'),
};

/** VITE_DEMO=1 (npm run build:demo): runs entirely in the browser on sample data. */
export const api: typeof httpApi = import.meta.env.VITE_DEMO === '1' ? demoApi : httpApi;

export type { T };
