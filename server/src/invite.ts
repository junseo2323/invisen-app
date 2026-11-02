// Issue a login code from the server (until the admin dashboard exists, and for the first manager).
//   npm run invite -- 01012345678 [hours]       (in production: sudo invisen-admin invite 010…)
import { pool, one } from './db.js';
import { migrate } from './migrate.js';
import { issueInvite } from './invites.js';
import { normalizePhone } from './http.js';

const [phoneArg, hoursArg] = process.argv.slice(2);
if (!phoneArg) {
  console.error('사용법: invite <휴대폰 번호> [유효 시간(시간), 기본 72]');
  process.exit(1);
}
await migrate(() => {});
const w = await one<{ id: number; name: string }>('select id, name from workers where phone = $1 and active', [normalizePhone(phoneArg)]);
if (!w) {
  console.error(`등록된 작업자가 아니에요: ${phoneArg}`);
  process.exit(1);
}
const inv = await issueInvite(w.id, null, hoursArg ? Number(hoursArg) : undefined);
console.log(`${w.name} (${phoneArg}) 등록 코드: ${inv.code}  — ${new Date(inv.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} 까지, 한 번만 쓸 수 있어요`);
await pool.end();
