// Requests, demo mode, offline queue and local cache. Global: TLNet.
(function () {
  var C = globalThis.TLCore;
  var REQUEST_TIMEOUT_MS = 15000;
  var K_QUEUE = 'tl.queue';
  var K_RECENT = 'tl.clients.recent';
  var CLIENT_PREFIX = 'tl.client.';
  var MAX_CLIENTS = 10;

  var apiUrl = '', initData = '', mock = null;
  var queue = [];
  var listeners = [];
  var flushing = false, again = false, running = null;
  var rejectedAll = [];   // persisted in tl.rejected until dismissed
  var lastErr = null;
  var inited = false;
  var K_REJECTED = 'tl.rejected';
  var KINDS = ['exercise', 'deleteExercise', 'measure', 'deleteMeasure', 'sessionNote', 'clientNote', 'report'];

  function validItem(it) {
    return !!it && typeof it === 'object' && KINDS.indexOf(it.kind) !== -1 && typeof it.client === 'string' &&
      (it.kind === 'clientNote' || typeof it.date === 'string');
  }
  function loadItems(key) {
    var v = lsGet(key, []);
    return Array.isArray(v) ? v.filter(validItem) : [];
  }

  // ---------- storage (may be unavailable) ----------
  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* works for this session only */ }
  }
  function lsRemove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function cacheGet(key) { return lsGet(key, null); }

  function cacheSet(key, value) {
    lsSet(key, value);
    if (key.indexOf(CLIENT_PREFIX) !== 0) return;
    var recent = lsGet(K_RECENT, []);
    if (!Array.isArray(recent)) recent = [];
    recent = recent.filter(function (k) { return k !== key; });
    recent.push(key);
    while (recent.length > MAX_CLIENTS) lsRemove(recent.shift());
    lsSet(K_RECENT, recent);
  }

  function cacheRemove(key) {
    lsRemove(key);
    var recent = lsGet(K_RECENT, []);
    if (!Array.isArray(recent)) return;
    lsSet(K_RECENT, recent.filter(function (k) { return k !== key; }));
  }

  // ---------- change notifications ----------
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function notify() {
    listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { /* a listener must not break the queue */ } });
  }
  function saveQueue() { lsSet(K_QUEUE, queue); }

  // ---------- mock ----------
  function isoDaysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    return C.localDate(d);
  }
  function isoMonthsAgo(n) {
    var d = new Date();
    var day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() - n);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return C.localDate(d);
  }

  var MOCK_CLIENTS = [
    { name: 'Марія С.', lastDate: null, absent: false, ago: 0 },
    { name: 'Олег П.', lastDate: null, absent: true, ago: 22 },
    { name: 'Тарас Д.', lastDate: null, absent: false, ago: null }
  ];
  var MOCK_TEMPLATES = {
    'Жінки': [
      { workout: 'Ноги', exercises: [{ name: 'Присідання', type: 'вага' }, { name: 'Планка', type: 'час' }] },
      { workout: 'Верх', exercises: [{ name: 'Тяга блоку', type: 'вага' }] }
    ],
    'Чоловіки': [
      { workout: 'Груди', exercises: [{ name: 'Жим лежачи', type: 'вага' }] },
      { workout: 'Спина', exercises: [{ name: 'Підтягування', type: 'вага' }, { name: 'Вис', type: 'час' }] }
    ]
  };
  // In-memory demo store for the manage actions; lasts until the page reloads.
  // base = name of the built-in demo client whose history (today/last/measures) this record keeps.
  var mockStore = null;

  function copyProgram(p) { return JSON.parse(JSON.stringify(p)); }

  function mockInit() {
    if (mockStore) return;
    mockStore = MOCK_CLIENTS.map(function (c) {
      var st = mockBaseState(c.name);
      return { name: c.name, base: c.name, active: true, ago: c.ago, absent: c.absent, goal: st.goal, note: st.note, program: st.program };
    });
  }

  function mockFind(name) {
    mockInit();
    for (var i = 0; i < mockStore.length; i++) if (mockStore[i].name === name) return mockStore[i];
    return null;
  }

  function mockClients() {
    mockInit();
    return mockStore.filter(function (r) { return r.active; }).map(function (r) {
      return { name: r.name, lastDate: r.ago === null ? null : isoDaysAgo(r.ago), absent: r.absent };
    });
  }

  function mockHiddenList() {
    mockInit();
    return mockStore.filter(function (r) { return !r.active; }).map(function (r) { return { name: r.name }; });
  }

  function mockClientState(name) {
    var rec = mockFind(name);
    if (!rec) return null;
    var st = rec.base ? mockBaseState(rec.base) : mockBaseState('');
    st.name = rec.name; st.goal = rec.goal; st.note = rec.note; st.program = copyProgram(rec.program);
    return st;
  }

  function mockWorkout(rec, workout, create) {
    for (var i = 0; i < rec.program.length; i++) if (rec.program[i].workout === workout) return rec.program[i];
    if (!create) return null;
    var w = { workout: workout, exercises: [] };
    rec.program.push(w);
    return w;
  }

  function mockManage(p) {
    mockInit();
    var rec;
    switch (p.action) {
      case 'addClient': {
        var name = C.checkName(p.name);
        if (name === null) return { ok: false, error: 'invalid_entry' };
        if (C.nameTaken(mockStore.map(function (r) { return r.name; }), name, null)) return { ok: false, error: 'duplicate_name' };
        mockStore.push({ name: name, base: null, active: true, ago: null, absent: false, goal: p.goal || '', note: p.note || '', program: copyProgram(MOCK_TEMPLATES[p.template] || []) });
        return { ok: true };
      }
      case 'editClient': {
        rec = mockFind(p.client);
        var nn = C.checkName(p.name);
        if (!rec || nn === null) return { ok: false, error: 'invalid_entry' };
        if (C.nameTaken(mockStore.map(function (r) { return r.name; }), nn, rec.name)) return { ok: false, error: 'duplicate_name' };
        rec.name = nn; rec.goal = p.goal || ''; rec.note = p.note || ''; rec.active = p.active !== false;
        return { ok: true };
      }
      case 'applyTemplate': {
        rec = mockFind(p.client);
        if (!rec || !MOCK_TEMPLATES[p.template] || rec.program.length) return { ok: false, error: 'invalid_entry' };
        MOCK_TEMPLATES[p.template].forEach(function (tw) {
          var w = mockWorkout(rec, tw.workout, true);
          tw.exercises.forEach(function (e) {
            if (!w.exercises.some(function (x) { return x.name === e.name; })) w.exercises.push({ name: e.name, type: e.type });
          });
        });
        return { ok: true };
      }
      case 'addExercise': {
        rec = mockFind(p.client);
        var wn = String(p.workout || '').trim(), en = String(p.exercise || '').trim();
        if (!rec || !wn || !en || (p.type !== 'вага' && p.type !== 'час')) return { ok: false, error: 'invalid_entry' };
        var dup = rec.program.some(function (w) { return w.exercises.some(function (x) { return x.name === en; }); });
        if (dup) return { ok: false, error: 'duplicate_exercise' };
        var w2 = mockWorkout(rec, wn, true);
        w2.exercises.push({ name: en, type: p.type });
        return { ok: true };
      }
      case 'removeExercise': {
        rec = mockFind(p.client);
        if (!rec) return { ok: false, error: 'invalid_entry' };
        // nothing matching is fine (idempotent retry), like the server
        var w3 = mockWorkout(rec, p.workout, false);
        if (w3) {
          w3.exercises = w3.exercises.filter(function (x) { return x.name !== p.exercise; });
          if (!w3.exercises.length) rec.program = rec.program.filter(function (x) { return x !== w3; });
        }
        return { ok: true };
      }
    }
    return { ok: false, error: 'unknown_action' };
  }

  function mockBaseState(name) {
    var base = { name: name, goal: '', note: '', program: [], today: {}, last: {}, measureTypes: [], measuresToday: {}, measuresLast: {}, sessionNote: '' };
    if (name === 'Марія С.') {
      return {
        name: name, goal: 'схуднення', note: 'Ліве коліно: без глибоких присідань',
        program: [
          { workout: 'Ноги', exercises: [{ name: 'Присідання', type: 'вага' }, { name: 'Планка', type: 'час' }] },
          { workout: 'Спина', exercises: [{ name: 'Тяга в нахилі', type: 'вага' }] }
        ],
        today: { 'Присідання': { workout: 'Ноги', type: 'вага', weight: 62.5, reps: 8, seconds: null, sets: 3 } },
        last: {
          'Присідання': { date: isoDaysAgo(1), type: 'вага', weight: 60, reps: 8, seconds: null, sets: 3 },
          'Планка': { date: isoDaysAgo(1), type: 'час', weight: null, reps: null, seconds: 75, sets: 3 },
          'Тяга в нахилі': { date: isoDaysAgo(4), type: 'вага', weight: 35, reps: 10, seconds: null, sets: 3 }
        },
        measureTypes: [{ param: 'Вага тіла', unit: 'кг' }, { param: 'Талія', unit: 'см' }, { param: 'Стегна', unit: 'см' }],
        measuresToday: {},
        measuresLast: { 'Вага тіла': { date: isoDaysAgo(8), value: 71.4 } },
        sessionNote: ''
      };
    }
    if (name === 'Олег П.') {
      base.goal = 'набір маси';
      base.program = [{ workout: 'Груди', exercises: [{ name: 'Жим лежачи', type: 'вага' }] }];
      base.last = { 'Жим лежачи': { date: isoDaysAgo(22), type: 'вага', weight: 80, reps: 6, seconds: null, sets: 4 } };
      base.measureTypes = [{ param: 'Вага тіла', unit: 'кг' }];
      return base;
    }
    return base;
  }

  var PERIOD_LABELS = { '4w': '4 тижні', '3m': '3 місяці', '6m': 'півроку', '1y': 'рік', 'all': 'весь час' };

  function mockProgress(p) {
    if (!p.exercises && !p.measures) return null;
    var starts = { '4w': isoDaysAgo(28), '3m': isoMonthsAgo(3), '6m': isoMonthsAgo(6), '1y': isoMonthsAgo(12), 'all': isoMonthsAgo(12) };
    var from = starts[p.period] || starts['4w'];
    var lines = [(p.client || 'Клієнт') + ', твій прогрес за ' + (PERIOD_LABELS[p.period] || PERIOD_LABELS['4w']) +
      ' (' + C.formatShortDate(from) + ' – ' + C.formatShortDate(C.localDate(new Date())) + '):'];
    if (p.exercises) lines.push('', '🏆 Присідання: 50 кг × 10 → 62,5 кг × 8 (+12,5 кг, особистий рекорд)', '📈 Планка: 0:45 → 1:15 (+30 с)');
    if (p.measures) lines.push('', 'Заміри:', 'Вага тіла: 74 → 71,4 кг (−2,6 кг)', 'Талія: 78 → 74 см (−4 см)');
    return lines.join('\n');
  }

  function mockRequest(payload) {
    switch (payload.action) {
      case 'clients': return { ok: true, who: 'Демо', clients: mockClients(), templates: Object.keys(MOCK_TEMPLATES), hidden: mockHiddenList() };
      case 'client': {
        var st = mockClientState(payload.client);
        return st ? { ok: true, client: st } : { ok: false, error: 'malformed' };
      }
      case 'save':
        if (mock === 'offline') throw new Error('offline');
        return { ok: true };
      case 'addClient': case 'editClient': case 'applyTemplate': case 'addExercise': case 'removeExercise':
        if (mock === 'offline') throw new Error('offline');
        return mockManage(payload);
      case 'progress': return { ok: true, text: mockProgress(payload) };
    }
    return { ok: false, error: 'unknown_action' };
  }

  // ---------- network ----------
  async function request(payload) {
    var body = Object.assign({ initData: initData, today: C.localDate(new Date()) }, payload);
    if (mock) return mockRequest(body);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    try {
      var r = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        signal: ctrl.signal
      });
      if (!r.ok) throw new Error('http ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- queue ----------
  function saveRejected() { lsSet(K_REJECTED, rejectedAll); }

  function enqueue(item) {
    queue = C.queueAdd(queue, item);
    var key = C.itemKey(item);
    var n = rejectedAll.length;
    rejectedAll = rejectedAll.filter(function (r) { return C.itemKey(r) !== key; });
    if (rejectedAll.length !== n) saveRejected();
    saveQueue();
    notify();
  }

  function getQueue() { return queue.slice(); }

  function rejected() { return rejectedAll.slice(); }
  function dismissRejected(key) {
    rejectedAll = rejectedAll.filter(function (r) { return C.itemKey(r) !== key; });
    saveRejected();
    notify();
  }
  function lastError() { return lastErr; }

  // one pass over the queue snapshot; `thisRun` collects the items rejected in this flush
  async function pass(thisRun) {
    var snapshot = queue.slice();
    var res = await C.flushQueue(snapshot, function (item) {
      return request({ action: 'save', item: item }).then(function (r) {
        if (r && !r.ok) lastErr = r;
        if (r && r.error === 'invalid_entry') {
          var key = C.itemKey(item);
          var stale = queue.some(function (q) { return q !== item && C.itemKey(q) === key; });
          if (!stale) {
            thisRun.push(item);
            rejectedAll = rejectedAll.filter(function (x) { return C.itemKey(x) !== key; });
            rejectedAll.push(item);
            saveRejected();
          }
        }
        return r;
      });
    });
    // keep items added meanwhile and items flushQueue did not finish
    queue = queue.filter(function (e) {
      return snapshot.indexOf(e) === -1 || res.queue.indexOf(e) !== -1;
    });
    saveQueue();
    notify();
    return res.failed;
  }

  // The whole loop, including the final `again` check, and the reset of `flushing`
  // happen with no await in between, so a flush() call can never land in a gap.
  async function run() {
    var thisRun = [];
    var failed = null;
    try {
      do {
        again = false;
        try { failed = await pass(thisRun); } catch (e) { failed = 'network'; }
        if (failed) again = false;
      } while (again);
      if (failed === null) lastErr = null;
    } finally {
      flushing = false;
      running = null;
    }
    notify();
    return { failed: failed, rejected: thisRun };
  }

  // Resolves {failed, rejected}: failed null = everything was sent or rejected,
  // otherwise 'network' or a server error code. A call during a running flush
  // schedules one more pass and resolves with the same result.
  function flush() {
    if (flushing) { again = true; return running; }
    flushing = true;
    running = run();
    return running;
  }

  function init(opts) {
    opts = opts || {};
    apiUrl = opts.apiUrl || '';
    initData = opts.initData || '';
    mock = opts.mock || null;
    if (inited) return; // storage is read once; the in-memory queue stays authoritative
    inited = true;
    queue = loadItems(K_QUEUE);
    rejectedAll = loadItems(K_REJECTED);
  }

  globalThis.TLNet = {
    init: init,
    request: request,
    enqueue: enqueue,
    flush: flush,
    sending: function () { return flushing; },
    queue: getQueue,
    rejected: rejected,
    dismissRejected: dismissRejected,
    lastError: lastError,
    cacheGet: cacheGet,
    cacheSet: cacheSet,
    cacheRemove: cacheRemove,
    onChange: onChange
  };
})();
