// Changes the iOS bundle ID everywhere it is used:
//   node scripts/set-bundle-id.mjs com.yourcompany.invisen
import { readFileSync, writeFileSync } from 'node:fs';

const id = process.argv[2];
if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(id ?? '')) {
  console.error('사용법: node scripts/set-bundle-id.mjs com.yourcompany.invisen');
  process.exit(1);
}
const files = {
  'ios/App/App.xcodeproj/project.pbxproj': [/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${id};`],
  'capacitor.config.ts': [/appId: '[^']+'/, `appId: '${id}'`],
  'server/src/config.ts': [/str\('APNS_TOPIC', '[^']+'\)/, `str('APNS_TOPIC', '${id}')`],
  'server/.env.example': [/APNS_TOPIC=.*/, `APNS_TOPIC=${id}`],
  'deploy/setup.sh': [/APNS_TOPIC=.*/, `APNS_TOPIC=${id}`],
};
for (const [file, [re, rep]] of Object.entries(files)) {
  const s = readFileSync(file, 'utf8');
  if (!re.test(s)) throw new Error(`${file}: pattern not found`);
  writeFileSync(file, s.replace(re, rep));
  console.log(`${file} → ${id}`);
}
console.log('서버에 이미 설치했다면 /etc/invisen/api.env 의 APNS_TOPIC 도 바꾸고 sudo invisen-admin restart');
