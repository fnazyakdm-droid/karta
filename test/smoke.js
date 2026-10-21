'use strict';
// Проверка серверной логики: два клиента, конфликт «взять в работу», «изучил», «отпустить».
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = 3999;
const dataFile = path.join(os.tmpdir(), `ram-test-${Date.now()}.json`);
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, cond) {
  console.log((cond ? 'OK   ' : 'FAIL ') + name);
  if (!cond) failed += 1;
}

function client(id, name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const c = { ws, log: [], users: [], addrs: new Map() };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      c.log.push(m);
      if (m.t === 'init') {
        c.users = m.users;
        m.addresses.forEach((a) => c.addrs.set(a.key, a));
        resolve(c);
      }
      if (m.t === 'users') c.users = m.users;
      if (m.t === 'address') c.addrs.set(m.addr.key, m.addr);
      if (m.t === 'address_removed') c.addrs.delete(m.key);
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', id, name })));
    c.send = (o) => ws.send(JSON.stringify(o));
  });
}

(async () => {
  await new Promise((resolve) => server.stdout.on('data', (d) => String(d).includes('запущена') && resolve()));

  const addr = { key: 'w123456', label: 'Казань, Баумана, 51', lat: 55.79, lon: 49.12 };
  const a = await client('user-aaaa-0001', 'Анна');
  const b = await client('user-bbbb-0002', 'Борис');
  await sleep(100);

  check('оба участника видны всем', a.users.length === 2 && b.users.length === 2);

  a.send({ t: 'viewing', addr });
  await sleep(100);
  const annaSeenByB = b.users.find((u) => u.name === 'Анна');
  check('Борис видит, какой адрес смотрит Анна', annaSeenByB && annaSeenByB.viewing && annaSeenByB.viewing.key === addr.key);

  a.send({ t: 'claim', addr });
  await sleep(100);
  check('Анна взяла адрес, Борис это видит', b.addrs.get(addr.key)?.by === 'Анна' && b.addrs.get(addr.key)?.status === 'working');

  b.send({ t: 'claim', addr });
  await sleep(100);
  check('Борис не может взять занятый адрес', b.log.some((m) => m.t === 'error') && a.addrs.get(addr.key).by === 'Анна');

  b.send({ t: 'done', key: addr.key });
  b.send({ t: 'release', key: addr.key });
  await sleep(100);
  check('Борис не может изучить или отпустить чужой адрес', a.addrs.get(addr.key)?.status === 'working');

  a.send({ t: 'done', key: addr.key });
  await sleep(100);
  check('Анна отметила «изучил», Борис видит', b.addrs.get(addr.key)?.status === 'done');

  a.send({ t: 'reopen', key: addr.key });
  await sleep(100);
  check('Анна вернула адрес в работу', b.addrs.get(addr.key)?.status === 'working');

  a.send({ t: 'rename', name: 'Анна К.' });
  await sleep(100);
  check('смена имени видна у адреса и в списке', b.addrs.get(addr.key)?.by === 'Анна К.' && b.users.some((u) => u.name === 'Анна К.'));

  a.send({ t: 'release', key: addr.key });
  await sleep(100);
  check('адрес освобождён', !b.addrs.has(addr.key));

  b.send({ t: 'claim', addr });
  await sleep(100);
  check('теперь Борис может взять адрес', a.addrs.get(addr.key)?.by === 'Борис');

  a.ws.close();
  await sleep(150);
  check('после выхода Анны остаётся один участник', b.users.length === 1);

  const c = await client('user-bbbb-0002', 'Борис');
  check('после перезахода адрес всё ещё у Бориса', c.addrs.get(addr.key)?.by === 'Борис');

  b.ws.close();
  c.ws.close();
  server.kill('SIGTERM');
  await sleep(300);
  const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  check('данные сохранены на диск', saved[addr.key]?.by === 'Борис');
  fs.rmSync(dataFile, { force: true });

  console.log(failed ? `\nПровалено: ${failed}` : '\nВсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})();
