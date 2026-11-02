import { Screen, StaticScreen } from '../dc';
import * as L from './logic';

import Main from './markup/Main.html?raw';
import LoginPhone from './markup/Login-Phone.html?raw';
import LoginProfile from './markup/Login-Profile.html?raw';
import LoginSensor from './markup/Login-Sensor.html?raw';
import LoginWear from './markup/Login-Wear.html?raw';
import Home from './markup/Home.html?raw';
import HomeCaution from './markup/Home-Caution.html?raw';
import AlertDanger from './markup/Alert-Danger.html?raw';
import Site from './markup/Site.html?raw';
import Sensor from './markup/Sensor.html?raw';
import Exposure from './markup/Exposure.html?raw';
import Log from './markup/Log.html?raw';
import More from './markup/More.html?raw';
import Sos from './markup/SOS.html?raw';

export type Access = 'public' | 'onboarding' | 'app';

export interface ScreenDef {
  title: string;
  /** One template, or variants picked by renderVals().$variant */
  markup: string | Record<string, string>;
  logic: new () => Screen;
  access: Access;
}

// Route = artboard file name, lower-cased (Home-Caution.dc.html -> #/home-caution).
export const screens: Record<string, ScreenDef> = {
  main: { title: '시작', markup: Main, logic: StaticScreen, access: 'public' },
  'login-phone': { title: '휴대폰 인증', markup: LoginPhone, logic: L.LoginPhone, access: 'public' },
  'login-profile': { title: '소속 확인', markup: LoginProfile, logic: L.LoginProfile, access: 'onboarding' },
  'login-sensor': { title: '센서 연결', markup: LoginSensor, logic: L.LoginSensor, access: 'onboarding' },
  'login-wear': { title: '착용과 권한', markup: LoginWear, logic: L.LoginWear, access: 'onboarding' },
  home: { title: '홈', markup: { safe: Home, caution: HomeCaution }, logic: L.Home, access: 'app' },
  // kept as its own route so the design's 12번 artboard is still reachable
  'home-caution': { title: '홈', markup: { safe: Home, caution: HomeCaution }, logic: L.Home, access: 'app' },
  'alert-danger': { title: '위험 알림', markup: AlertDanger, logic: L.AlertDanger, access: 'app' },
  site: { title: '현장', markup: Site, logic: L.Site, access: 'app' },
  sensor: { title: '센서값', markup: Sensor, logic: L.Sensor, access: 'app' },
  exposure: { title: '노출량', markup: Exposure, logic: L.ExposureScreen, access: 'app' },
  log: { title: '기록', markup: Log, logic: L.Log, access: 'app' },
  more: { title: '전체', markup: More, logic: L.More, access: 'app' },
  sos: { title: 'SOS 긴급 호출', markup: Sos, logic: L.Sos, access: 'app' },
};
