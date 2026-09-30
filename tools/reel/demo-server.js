// A demo monitor for the reel: the real page, with made-up projects, agents, messages and one approval request.
// Nothing here comes from this PC's sessions or accounts.
const http = require('http'), fs = require('fs'), path = require('path');
const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8').replace('__MONITOR_TOKEN__', 'demo');
const REEL = path.join(__dirname, 'reel.html');
const T0 = Date.now();
const min = (n) => T0 - n * 60000;
let asking = false;
const streams = new Set();

const act = (key, kind, arg = '') => ({ key, kind, arg });
function sess(name, nickKo, o) {
  const short = name.slice(name.lastIndexOf('-'));
  return {
    id: name.slice(-4), name, short, nick: nickKo, nickKo, avatar: null, state: 'working', statusSince: min(6), startedAt: min(95), kind: 'vscode',
    role: '', title: '', activity: null, activityAt: min(0.2), lastEventAt: min(0.1), sentCount: 0, mode: 'acceptEdits', listening: false, queued: 0,
    context: 48000, errors: 0, results: 12, lastErrorAt: 0, lastSignAt: min(0.1), subagents: [], today: null, stalledFor: 0, isLeader: false, ...o,
  };
}
function projects() {
  const shop = [
    sess('shop-web-1a', '민준', { isLeader: true, role: '리더 · 결제 화면 개편', activity: act('edit', 'edit', 'CheckoutPage.tsx'), context: 91000, today: { total: 3.2e6, in: 900, out: 61000, cacheRead: 3.0e6, cacheWrite: 140000 } }),
    sess('shop-web-3c', '서연', { role: '결제 테스트', activity: act('shell', 'shell', '결제 모듈 테스트 실행'), today: { total: 1.9e6, in: 400, out: 38000, cacheRead: 1.8e6, cacheWrite: 90000 } }),
    sess('shop-web-7f', '지호', { state: 'waiting', statusSince: min(4), role: '디자인 QA', activity: act('read', 'read', 'design-tokens.css'), activityAt: min(4), today: { total: 0.6e6, in: 100, out: 9000, cacheRead: 0.58e6, cacheWrite: 20000 } }),
    sess('shop-web-9d', '하은', { role: '배포 준비', activity: act('shell', 'shell', '스테이징 빌드'), mode: 'default', today: { total: 1.1e6, in: 200, out: 21000, cacheRead: 1.05e6, cacheWrite: 40000 } }),
    sess('shop-web-b2', '도윤', { state: 'resting', statusSince: min(48), role: '문서 정리', activity: act('write', 'edit', 'CHANGELOG.md'), activityAt: min(48) }),
  ];
  if (asking) { const h = shop[3]; h.state = 'waiting'; h.statusSince = min(0.05); }
  const api = [
    sess('api-server-2e', '수아', { isLeader: true, role: '리더 · 주문 API', activity: act('grep', 'search'), today: { total: 2.4e6, in: 500, out: 44000, cacheRead: 2.3e6, cacheWrite: 100000 } }),
    sess('api-server-5a', '예준', { state: 'waiting', statusSince: min(7), role: 'DB 마이그레이션', activity: act('edit', 'edit', 'orders.sql'), activityAt: min(7) }),
    sess('api-server-8b', '하린', { kind: 'monitor', managed: true, agentId: 'demo1', running: true, role: '성능 점검', activity: act('shell', 'shell', '부하 테스트 실행') }),
  ];
  const app = [
    sess('mobile-app-4c', '시우', { isLeader: true, state: 'waiting', statusSince: min(12), role: '리더 · 푸시 알림', activity: act('read', 'read', 'push.ts'), activityAt: min(12) }),
    sess('mobile-app-6d', '채원', { state: 'resting', statusSince: min(70), role: '스토어 설명 번역', activity: act('write', 'edit', 'store-ko.md'), activityAt: min(70) }),
  ];
  const msg = (from, fromNickKo, to, toNickKo, summary, ago) => ({ from, to, summary, at: min(ago), fromNick: fromNickKo, fromNickKo, toNick: toNickKo, toNickKo });
  const count = (list) => ({ working: list.filter((s) => s.state === 'working').length, waiting: list.filter((s) => s.state === 'waiting').length, resting: list.filter((s) => s.state === 'resting').length });
  return [
    { key: 'shop-web', root: 'C:/work/shop-web', label: '쇼핑몰', leader: 'shop-web-1a', sessions: shop, counts: count(shop),
      messages: [
        msg('shop-web-3c', '서연', 'shop-web-1a', '민준', '결제 테스트 42개 통과, 쿠폰 계산 1개 실패', 1),
        msg('shop-web-1a', '민준', 'shop-web-3c', '서연', '쿠폰 계산 고쳤어요, 다시 돌려 주세요', 2),
        msg('shop-web-1a', '민준', 'shop-web-9d', '하은', '테스트 통과하면 스테이징에 올려 주세요', 5),
        msg('shop-web-7f', '지호', 'shop-web-1a', '민준', '버튼 색 대비 확인 끝', 9),
      ],
      board: { updatedAt: new Date(min(1)).toISOString(), roles: {}, decisions: [{ title: '쿠폰 중복 적용 허용할지', status: 'open', order: 1 }], tasks: [
        { title: '결제 화면 새 디자인 적용', session: '-1a', status: 'running' },
        { title: '결제 모듈 테스트', session: '-3c', status: 'running' },
        { title: '스테이징 배포', session: '-9d', status: 'queued', order: 1 },
        { title: '다크 모드 색 점검', session: '-7f', status: 'done', doneAt: new Date(min(9)).toISOString() },
      ] } },
    { key: 'api-server', root: 'C:/work/api-server', label: '주문 API', leader: 'api-server-2e', sessions: api, counts: count(api), board: null,
      messages: [msg('api-server-2e', '수아', 'api-server-5a', '예준', '인덱스 추가하고 알려 주세요', 3)] },
    { key: 'mobile-app', root: 'C:/work/mobile-app', label: '앱', leader: 'mobile-app-4c', sessions: app, counts: count(app), board: null, messages: [] },
  ];
}
function state() {
  const now = Date.now();
  return {
    now, version: '0.2.4', token: 'demo', inEditor: [], recent: [],
    usage: { source: 'live', at: now, limits: [{ kind: 'session', percent: 42, resetsAt: new Date(now + 3 * 3600e3).toISOString() }, { kind: 'weekly_all', percent: 27, resetsAt: new Date(now + 4 * 86400e3).toISOString() }] },
    projects: projects(),
    approvals: asking ? [{ id: 'demo-ask', project: 'shop-web', session: 'shop-web-9d', short: '-9d', nick: '하은', nickKo: '하은', isLeader: false, about: '배포 준비', managed: false,
      tool: 'Bash', what: '스테이징 배포 스크립트 실행', code: './scripts/deploy.sh --env staging', options: ['Bash(./scripts/deploy.sh:*)'], questions: null, plan: '', at: now - 1000, expiresAt: now + 55000 }] : [],
  };
}
http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (u === '/') { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return r.end(PAGE); }
  if (u === '/reel.html') { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return r.end(fs.readFileSync(REEL)); }
  if (u === '/api/state') { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(JSON.stringify(state())); }
  if (u === '/api/events') { r.writeHead(200, { 'content-type': 'text/event-stream' }); r.write('retry: 2000\n\n'); streams.add(r); q.on('close', () => streams.delete(r)); return; }
  if (u === '/demo/ask') { asking = q.url.includes('on=1'); for (const s of streams) s.write('event: changed\ndata: {}\n\n'); return r.end('{}'); }
  r.writeHead(404); r.end();
}).listen(4798, '127.0.0.1', () => console.log('demo on', 4798));
