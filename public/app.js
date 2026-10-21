(() => {
  'use strict';

  const STATUS_COLOR = { working: '#d98e04', done: '#2e8b57' };

  /* ---------- утилиты ---------- */

  const $ = (s) => document.querySelector(s);

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return n;
  }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch {
      return null;
    }
    return null;
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'u' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  const time = (t) => new Date(t).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });

  /* ---------- состояние ---------- */

  let config = { tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap' };
  const me = { id: store('ram.id') || uuid(), name: store('ram.name') || '', color: '#0b6e78' };
  store('ram.id', me.id);

  let ws = null;
  let retry = 0;
  let users = [];
  const addrs = new Map();
  let selected = null;
  let filter = 'all';

  let map = null;
  const statusLayer = L.layerGroup();
  const statusMarkers = new Map();
  const peerMarkers = new Map();
  let selMarker = null;

  /* ---------- связь ---------- */

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      retry = 0;
      $('#conn').hidden = true;
      send({ t: 'hello', id: me.id, name: me.name });
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      handle(msg);
    };
    ws.onclose = () => {
      $('#conn').hidden = false;
      retry += 1;
      setTimeout(connect, Math.min(1000 * retry, 8000));
    };
    ws.onerror = () => {};
  }

  function handle(msg) {
    switch (msg.t) {
      case 'init':
        applyYou(msg.you);
        users = msg.users;
        addrs.clear();
        for (const a of msg.addresses) addrs.set(a.key, a);
        syncStatusMarkers();
        renderAll();
        if (selected) send({ t: 'viewing', addr: pick(selected) });
        break;
      case 'you':
        applyYou(msg.you);
        renderAll();
        break;
      case 'users':
        users = msg.users;
        syncPeerMarkers();
        renderUsers();
        renderCard();
        break;
      case 'address':
        addrs.set(msg.addr.key, msg.addr);
        syncStatusMarker(msg.addr);
        renderList();
        renderCard();
        break;
      case 'address_removed':
        addrs.delete(msg.key);
        removeStatusMarker(msg.key);
        renderList();
        renderCard();
        break;
      case 'error':
        toast(msg.message);
        break;
    }
  }

  function applyYou(you) {
    me.name = you.name;
    me.color = you.color;
    store('ram.name', me.name);
    $('#meName').textContent = me.name;
    $('#meDot').style.background = me.color;
  }

  const pick = (a) => ({ key: a.key, label: a.label, lat: a.lat, lon: a.lon });

  /* ---------- карта ---------- */

  function initMap() {
    map = L.map('map', { minZoom: 3, worldCopyJump: false, zoomControl: true }).setView([61, 96], 3);
    L.tileLayer(config.tileUrl, { maxZoom: 19, attribution: config.attribution }).addTo(map);
    statusLayer.addTo(map);
    map.on('click', onMapClick);
  }

  async function onMapClick(e) {
    if (map.getZoom() < 16) {
      toast('Приблизьте карту, чтобы выбрать дом');
      return;
    }
    try {
      const r = await fetch(`/api/reverse?lat=${e.latlng.lat}&lon=${e.latlng.lng}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Ошибка');
      if (!data) return toast('Здесь адрес не найден');
      select(data, { fly: false });
    } catch (err) {
      toast(err.message);
    }
  }

  function pinIcon(color, label, mine) {
    const root = el('div', { class: 'pin' + (mine ? ' me' : '') }, el('i'), label ? el('b', { text: label }) : null);
    root.style.setProperty('--c', color);
    return L.divIcon({ html: root, className: '', iconSize: [0, 0] });
  }

  function syncStatusMarker(a) {
    let m = statusMarkers.get(a.key);
    const color = STATUS_COLOR[a.status] || STATUS_COLOR.working;
    const text = `${a.status === 'done' ? 'Изучил' : 'В работе'}: ${a.by}`;
    if (!m) {
      m = L.circleMarker([a.lat, a.lon], { radius: 7, weight: 2, color: '#fff', fillOpacity: 1, bubblingMouseEvents: false });
      m.on('click', () => select(addrs.get(a.key) || a, { fly: false }));
      m.addTo(statusLayer);
      statusMarkers.set(a.key, m);
    }
    m.setStyle({ fillColor: color });
    m.unbindTooltip();
    m.bindTooltip(el('div', {}, el('b', { text: text }), el('br'), a.label), { className: 'tip', direction: 'top' });
  }

  function removeStatusMarker(key) {
    const m = statusMarkers.get(key);
    if (m) {
      statusLayer.removeLayer(m);
      statusMarkers.delete(key);
    }
  }

  function syncStatusMarkers() {
    for (const k of [...statusMarkers.keys()]) removeStatusMarker(k);
    for (const a of addrs.values()) syncStatusMarker(a);
  }

  function syncPeerMarkers() {
    const live = new Set();
    for (const u of users) {
      if (u.id === me.id || !u.viewing) continue;
      live.add(u.id);
      let m = peerMarkers.get(u.id);
      const tip = el('div', {}, el('b', { text: u.name + ' смотрит' }), el('br'), u.viewing.label);
      if (!m) {
        m = L.marker([u.viewing.lat, u.viewing.lon], { icon: pinIcon(u.color, u.name, false), zIndexOffset: 500, bubblingMouseEvents: false });
        m.on('click', () => select(m._addr, { fly: false }));
        m.addTo(map);
        peerMarkers.set(u.id, m);
      } else {
        m.setLatLng([u.viewing.lat, u.viewing.lon]);
        m.setIcon(pinIcon(u.color, u.name, false));
      }
      m._addr = u.viewing;
      m.unbindTooltip();
      m.bindTooltip(tip, { className: 'tip', direction: 'top', offset: [0, -10] });
    }
    for (const [id, m] of peerMarkers) {
      if (!live.has(id)) {
        map.removeLayer(m);
        peerMarkers.delete(id);
      }
    }
  }

  /* ---------- выбор адреса ---------- */

  function select(addr, opts) {
    selected = pick(addr);
    if (selMarker) map.removeLayer(selMarker);
    selMarker = L.marker([selected.lat, selected.lon], { icon: pinIcon(me.color, '', true), interactive: false, zIndexOffset: 1000 }).addTo(map);
    if (!opts || opts.fly !== false) map.flyTo([selected.lat, selected.lon], Math.max(map.getZoom(), 17), { duration: 0.8 });
    send({ t: 'viewing', addr: selected });
    renderCard();
    $('#panel').scrollTo({ top: 0, behavior: 'smooth' });
  }

  function deselect() {
    selected = null;
    if (selMarker) map.removeLayer(selMarker);
    selMarker = null;
    send({ t: 'viewing', addr: null });
    renderCard();
  }

  /* ---------- отрисовка ---------- */

  function renderAll() {
    $('#meName').textContent = me.name;
    renderUsers();
    renderList();
    renderCard();
    syncPeerMarkers();
  }

  function renderCard() {
    const block = $('#cardBlock');
    const card = $('#card');
    if (!selected) {
      block.hidden = true;
      card.replaceChildren();
      return;
    }
    block.hidden = false;
    const rec = addrs.get(selected.key);
    const mine = rec && rec.byId === me.id;
    const others = users.filter((u) => u.id !== me.id && u.viewing && u.viewing.key === selected.key);

    let statusText = 'Свободен. Никто не взял его в работу.';
    let cls = '';
    if (rec) {
      cls = rec.status;
      if (rec.status === 'working') statusText = mine ? 'В работе у вас' : `В работе: ${rec.by}`;
      else statusText = mine ? 'Вы изучили этот адрес' : `Изучил: ${rec.by}`;
      statusText += ` (${time(rec.at)})`;
    }

    const actions = [];
    if (!rec) {
      actions.push(el('button', { class: 'primary', type: 'button', text: 'Взять в работу', onclick: () => send({ t: 'claim', addr: selected }) }));
    } else if (mine && rec.status === 'working') {
      actions.push(el('button', { class: 'primary', type: 'button', text: 'Изучил', onclick: () => send({ t: 'done', key: rec.key }) }));
      actions.push(el('button', { type: 'button', text: 'Отпустить', onclick: () => send({ t: 'release', key: rec.key }) }));
    } else if (mine && rec.status === 'done') {
      actions.push(el('button', { type: 'button', text: 'Вернуть в работу', onclick: () => send({ t: 'reopen', key: rec.key }) }));
      actions.push(el('button', { type: 'button', text: 'Снять отметку', onclick: () => send({ t: 'release', key: rec.key }) }));
    } else {
      actions.push(el('button', { type: 'button', disabled: true, text: rec.status === 'done' ? `Изучил: ${rec.by}` : `В работе: ${rec.by}` }));
    }

    card.replaceChildren(
      el(
        'div',
        { class: 'card-top' },
        el('div', {}, el('div', { class: 'card-title', text: selected.label }), el('div', { class: 'coords', text: `${selected.lat.toFixed(5)}, ${selected.lon.toFixed(5)}` })),
        el('button', { class: 'x', type: 'button', 'aria-label': 'Закрыть', text: '×', onclick: deselect })
      ),
      el('div', { class: 'status ' + cls, text: statusText }),
      el('div', { class: 'actions' }, actions),
      others.length ? el('div', { class: 'viewers', text: 'Сейчас тоже смотрят: ' + others.map((u) => u.name).join(', ') }) : null
    );
  }

  function renderUsers() {
    $('#onlineCount').textContent = users.length;
    const list = $('#users');
    const sorted = [...users].sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.name.localeCompare(b.name, 'ru')));
    list.replaceChildren(
      ...sorted.map((u) => {
        const avatar = el('span', { class: 'avatar', text: (u.name[0] || '?').toUpperCase() });
        avatar.style.background = u.color;
        const info = el(
          'span',
          { class: 'who' },
          el('span', { class: 'nm', text: u.name + (u.id === me.id ? ' (вы)' : '') }),
          el('span', { class: 'sub', text: u.viewing ? u.viewing.label : 'ничего не открыто' })
        );
        const inner = el('span', { style: 'display:flex;gap:10px;align-items:flex-start' }, avatar, info);
        if (!u.viewing) return el('li', {}, inner);
        return el('li', {}, el('button', { type: 'button', title: 'Показать на карте', onclick: () => select(u.viewing) }, inner));
      })
    );
  }

  function renderList() {
    const all = [...addrs.values()].sort((a, b) => b.at - a.at);
    const counts = {
      all: all.length,
      working: all.filter((a) => a.status === 'working').length,
      done: all.filter((a) => a.status === 'done').length,
      mine: all.filter((a) => a.byId === me.id).length,
    };
    for (const b of document.querySelectorAll('#tabs button')) {
      b.setAttribute('aria-selected', String(b.dataset.f === filter));
      b.querySelector('.count').textContent = counts[b.dataset.f];
    }
    const shown = all.filter((a) => (filter === 'all' ? true : filter === 'mine' ? a.byId === me.id : a.status === filter));
    const list = $('#addrList');
    if (!shown.length) {
      list.replaceChildren(el('li', { class: 'empty', text: 'Пока пусто.' }));
      return;
    }
    list.replaceChildren(
      ...shown.map((a) =>
        el(
          'li',
          {},
          el(
            'button',
            { class: 'row', type: 'button', onclick: () => select(a) },
            el('span', { class: 't' }, a.label, el('span', { class: 'by', text: `${a.by}, ${time(a.at)}` })),
            el('span', { class: 'chip ' + a.status, text: a.status === 'done' ? 'Изучено' : 'В работе' })
          )
        )
      )
    );
  }

  /* ---------- поиск ---------- */

  let searchSeq = 0;

  async function search(q) {
    const seq = ++searchSeq;
    const results = $('#results');
    const msg = $('#searchMsg');
    q = q.trim();
    if (q.length < 3) {
      results.hidden = true;
      msg.hidden = true;
      return;
    }
    msg.hidden = false;
    msg.textContent = 'Ищу…';
    try {
      const r = await fetch('/api/search?q=' + encodeURIComponent(q));
      const data = await r.json();
      if (seq !== searchSeq) return;
      if (!r.ok) throw new Error(data.error || 'Ошибка поиска');
      if (!data.length) {
        results.hidden = true;
        msg.textContent = 'Ничего не найдено. Уточните город, улицу и номер дома.';
        return;
      }
      msg.hidden = true;
      results.hidden = false;
      results.replaceChildren(
        ...data.map((a) => {
          const rec = addrs.get(a.key);
          return el(
            'li',
            {},
            el(
              'button',
              {
                class: 'row',
                type: 'button',
                onclick: () => {
                  select(a);
                  results.hidden = true;
                },
              },
              el('span', { class: 't', text: a.label }),
              rec ? el('span', { class: 'chip ' + rec.status, text: rec.by }) : null
            )
          );
        })
      );
    } catch (err) {
      if (seq !== searchSeq) return;
      results.hidden = true;
      msg.hidden = false;
      msg.textContent = err.message;
    }
  }

  /* ---------- интерфейс ---------- */

  let toastTimer = null;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  function askName(first) {
    $('#gateTitle').textContent = first ? 'Как вас зовут?' : 'Сменить имя';
    $('#gateCancel').hidden = first;
    $('#nameInput').value = me.name;
    $('#gate').hidden = false;
    setTimeout(() => $('#nameInput').focus(), 0);
  }

  function bind() {
    $('#searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      search($('#q').value);
    });
    let timer = null;
    $('#q').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => search($('#q').value), 700);
    });
    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-f]');
      if (!b) return;
      filter = b.dataset.f;
      renderList();
    });
    $('#meBtn').addEventListener('click', () => askName(false));
    $('#gateCancel').addEventListener('click', () => ($('#gate').hidden = true));
    $('#gateForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#nameInput').value.replace(/\s+/g, ' ').trim().slice(0, 30);
      if (!name) return;
      const first = !me.name;
      me.name = name;
      store('ram.name', name);
      $('#meName').textContent = name;
      $('#gate').hidden = true;
      if (first) connect();
      else send({ t: 'rename', name });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#gate').hidden && me.name) $('#gate').hidden = true;
        else if (selected) deselect();
      }
    });
  }

  async function boot() {
    try {
      const r = await fetch('/api/config');
      if (r.ok) config = await r.json();
    } catch {
      /* используем значения по умолчанию */
    }
    initMap();
    bind();
    $('#meName').textContent = me.name || '…';
    if (me.name) connect();
    else askName(true);
  }

  boot();
})();
