// SMS senders. 'console' prints the code to the server log (development).
// 'nhncloud' uses NHN Cloud Notification SMS v3.0.
import { config } from './config.js';

export interface SmsSender {
  send(to: string, body: string): Promise<void>;
}

const consoleSender: SmsSender = {
  async send(to, body) {
    console.log(`[sms:console] to=${to} ${body}`);
  },
};

const nhnCloudSender: SmsSender = {
  async send(to, body) {
    const { nhnAppKey, nhnSecretKey, nhnSender } = config.sms;
    if (!nhnAppKey || !nhnSecretKey || !nhnSender) throw new Error('NHN Cloud SMS is not configured');
    const res = await fetch(`https://api-sms.cloud.toast.com/sms/v3.0/appKeys/${nhnAppKey}/sender/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8', 'X-Secret-Key': nhnSecretKey },
      body: JSON.stringify({ body, sendNo: nhnSender, recipientList: [{ recipientNo: to }] }),
    });
    const json = (await res.json().catch(() => null)) as { header?: { isSuccessful?: boolean; resultMessage?: string } } | null;
    if (!res.ok || !json?.header?.isSuccessful) {
      throw new Error(`NHN Cloud SMS failed: ${res.status} ${json?.header?.resultMessage ?? ''}`);
    }
  },
};

export const sms: SmsSender = config.sms.provider === 'nhncloud' ? nhnCloudSender : consoleSender;
