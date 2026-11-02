// Release build for the iOS app: web build pointed at the production API, then copy into Xcode.
//   VITE_API_URL=https://app.example.com npm run ios:release
// Refuses to run without an https URL (iOS blocks plain http, and a missing URL would ship
// an app that talks to nothing).
import { execSync } from 'node:child_process';

const url = (process.env.VITE_API_URL ?? '').replace(/\/$/, '');
if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(url)) {
  console.error('VITE_API_URL 에 https 도메인을 넣어주세요. 예: VITE_API_URL=https://app.example.com npm run ios:release');
  process.exit(1);
}
if (process.env.VITE_SENSOR === 'sim') {
  console.error('VITE_SENSOR=sim 은 시뮬레이터 테스트용이에요. 릴리스 빌드에서는 빼주세요.');
  process.exit(1);
}
const env = { ...process.env, VITE_API_URL: url, VITE_DEMO: '' };
const run = (cmd) => execSync(cmd, { stdio: 'inherit', env });

console.log(`API: ${url}`);
try {
  const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
  console.log(`서버 확인: ${r.status} ${await r.text()}`);
} catch (e) {
  console.warn(`[주의] ${url}/api/health 에 닿지 않아요 (${e.message}). 빌드는 계속합니다.`);
}
run('INVISEN_APP_ONLY=1 npm run build');
run('npx cap sync ios');
console.log('\n준비 완료. Xcode: npm run ios:open → Product › Archive, 또는 GitHub Actions 의 "iOS TestFlight" 실행.');
