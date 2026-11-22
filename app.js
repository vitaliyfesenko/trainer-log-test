(function () {
  var C = TLCore, N = TLNet;
  var ACCESS_ERRORS = ['forbidden', 'expired', 'bad_signature', 'not_configured'];
  var K_CLIENTS = 'tl.clients', K_CLIENT = 'tl.client.';

  var params = new URLSearchParams(location.search);
  var mock = params.get('mock'); // '1', 'offline' or null
  var tg = (window.Telegram && window.Telegram.WebApp) || null;
  var initData = (tg && tg.initData) || '';
  var apiUrl = window.TRAINER_API_URL || '';

  var root = document.getElementById('app');

  var screen = 'list';      // 'list' | 'client' | 'progress'
  var clients = null;       // [{name, lastDate, absent}]
  var query = '';
  var clientName = null;
  var cstate = null;        // ClientState of clientName
  var cstateDate = null;    // date for which cstate.today is valid
  var tab = 'train';        // 'train' | 'measure'
  var selected = null;      // selected workout
  var openKey = null;       // open form: 'ex|<name>' or 'm|<param>'
  var draft = null;         // text values of the open form
  var confirmKey = null;    // row whose delete is awaiting confirmation
  var noteEdit = false, noteDraft = '';
  var sessionDraft = null;  // unsaved text of the session note (null: untouched)
  var notice = null;        // {text, retry, blocking, fromLoad}
  var syncing = false;
  var mine = [];            // enqueued items not yet folded into the server state
  var appliedLog = [];      // items folded in during this session

  function today() { return C.localDate(new Date()); }

  // ---------- messages ----------
  function errorNotice(code, res) {
    if (code === 'forbidden') {
      return { text: 'У вас немає доступу. Ваш Telegram ID: ' + (res && res.userId) + '. Передайте його власнику щоденника.', blocking: true };
    }
    if (code === 'expired' || code === 'bad_signature') {
      return { text: 'Сеанс застарів. Закрийте й відкрийте додаток знову.', blocking: true };
    }
    if (code === 'not_configured') {
      return { text: 'Скрипт не налаштовано: додайте BOT_TOKEN у властивості скрипта.', blocking: true };
    }
    return { text: 'Помилка сервера (' + code + '). Спробуйте ще раз.', retry: true };
  }

  function flushNotice(failed) {
    return failed && failed !== 'network' ? errorNotice(failed, N.lastError()) : null;
  }

  // ---------- client cache ----------
  function loadCached(name) {
    var raw = N.cacheGet(K_CLIENT + name);
    if (!raw || !raw.state || !Array.isArray(raw.state.program)) return null;
    var st = raw.state;
    if (raw.date !== today()) { // yesterday's "today" must never show as today's
      st.today = {}; st.measuresToday = {}; st.sessionNote = '';
    }
    return st;
  }
  function saveCached(name, st) { N.cacheSet(K_CLIENT + name, { date: today(), state: st }); }

  // ---------- folding sent items into the state ----------
  function exType(st, name) {
    var t = 'вага';
    (st.program || []).forEach(function (w) {
      w.exercises.forEach(function (x) { if (x.name === name) t = x.type; });
    });
    return t;
  }

  function applyItem(st, it) {
    switch (it.kind) {
      case 'exercise':
        st.today = st.today || {};
        st.today[it.exercise] = { workout: it.workout, type: exType(st, it.exercise), weight: it.weight, reps: it.reps, seconds: it.seconds, sets: it.sets };
        break;
      case 'deleteExercise': if (st.today) delete st.today[it.exercise]; break;
      case 'measure':
        st.measuresToday = st.measuresToday || {};
        st.measuresToday[it.param] = it.value;
        break;
      case 'deleteMeasure': if (st.measuresToday) delete st.measuresToday[it.param]; break;
      case 'sessionNote': st.sessionNote = it.text; break;
      case 'clientNote': st.note = it.text; break;
    }
  }

  function applySent(it) {
    if (it.kind === 'report') return;
    if (it.kind !== 'clientNote' && it.date !== today()) return;
    appliedLog.push(it);
    if (cstate && clientName === it.client) {
      applyItem(cstate, it);
      saveCached(it.client, cstate);
      return;
    }
    var st = loadCached(it.client);
    if (st) { applyItem(st, it); saveCached(it.client, st); }
  }

  // items that left the queue without being rejected were sent
  function reconcile() {
    var q = N.queue();
    var rej = N.rejected().map(C.itemKey);
    mine = mine.filter(function (it) {
      if (q.indexOf(it) !== -1) return true;
      if (rej.indexOf(C.itemKey(it)) === -1) applySent(it);
      return false;
    });
  }

  function enqueue(item) {
    var key = C.itemKey(item);
    mine = mine.filter(function (m) { return C.itemKey(m) !== key; });
    mine.push(item);
    N.enqueue(item);
  }

  // ---------- sync: flush -> fetch ----------
  var syncAgain = false;
  function viewKey() { return screen === 'list' ? 'list' : (screen === 'client' ? 'client|' + clientName : null); }

  // One pass can fetch a screen the user has already left, or be asked for while
  // another pass runs: loop until the data of the current screen was fetched.
  async function sync() {
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    try {
      var fetched;
      do {
        syncAgain = false;
        fetched = await syncOnce();
      } while (syncAgain || (fetched !== null && fetched !== viewKey() && viewKey() !== null));
    } finally {
      syncing = false;
    }
  }

  // returns the key of the screen it fetched, or null when it did not fetch
  async function syncOnce() {
    var fr = await N.flush();
    notice = flushNotice(fr.failed);
    render();
    if (fr.failed && ACCESS_ERRORS.indexOf(fr.failed) !== -1) return null;
    if (screen === 'progress') return null;

    var forScreen = screen, forClient = clientName, mark = appliedLog.length;
    var key = viewKey();
    function current() { return screen === forScreen && (forScreen === 'list' || clientName === forClient); }
    var res;
    try {
      res = await N.request(forScreen === 'list' ? { action: 'clients' } : { action: 'client', client: forClient });
    } catch (e) {
      if (current() && ((forScreen === 'list' && !clients) || (forScreen === 'client' && !cstate))) {
        notice = { text: 'Немає зв\'язку. Спробуйте ще раз.', retry: true, fromLoad: true };
      }
      render();
      return key;
    }
    if (forScreen === 'list') {
      if (res && res.ok && Array.isArray(res.clients)) {
        clients = res.clients;
        N.cacheSet(K_CLIENTS, clients);
        if (current() && notice && notice.fromLoad) notice = null;
      } else if (current()) {
        notice = errorNotice((res && res.error) || 'server_error', res);
        notice.fromLoad = true;
      }
    } else if (res && res.ok && res.client && Array.isArray(res.client.program)) {
      var st = res.client;
      appliedLog.slice(mark).forEach(function (it) { if (it.client === forClient) applyItem(st, it); });
      saveCached(forClient, st);
      if (current()) {
        cstate = st; cstateDate = today();
        if (notice && notice.fromLoad) notice = null;
      }
    } else if (current()) {
      notice = errorNotice((res && res.error) || 'server_error', res);
      notice.fromLoad = true;
    }
    render();
    return key;
  }

  // ---------- rendering helpers ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function button(cls, text, fn) {
    var b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function itemLabel(it) {
    switch (it.kind) {
      case 'exercise': case 'deleteExercise': return it.exercise;
      case 'measure': case 'deleteMeasure': return it.param;
      case 'sessionNote': return 'нотатка до заняття';
      case 'clientNote': return 'постійна нотатка';
      case 'report': return 'звіт';
    }
    return 'запис';
  }

  // rejected items stay on screen until tapped or re-saved
  function renderRejected() {
    N.rejected().forEach(function (it) {
      var other = screen !== 'client' || it.client !== clientName;
      var b = el('div', 'banner', 'Запис «' + itemLabel(it) + '»' + (other ? ' (' + it.client + ')' : '') + ' відхилено сервером. Введіть його ще раз.');
      b.setAttribute('role', 'button');
      b.tabIndex = 0;
      b.addEventListener('click', function () { N.dismissRejected(C.itemKey(it)); });
      root.appendChild(b);
    });
  }

  function messageBlock(text, retry) {
    var box = el('div', 'message');
    box.appendChild(el('p', null, text));
    if (retry) box.appendChild(button('btn', 'Повторити', sync));
    return box;
  }

  function renderBar() {
    var n = N.queue().length;
    if (!n) return;
    var bar = el('div', 'bar');
    bar.appendChild(el('span', null, 'Не відправлено: ' + n));
    bar.appendChild(button('btn', 'Повторити', sync));
    root.appendChild(bar);
  }

  function renderBanner() {
    if (!notice) return;
    var banner = el('div', 'banner');
    banner.appendChild(el('p', null, notice.text));
    if (notice.retry) banner.appendChild(button('btn', 'Повторити', sync));
    root.appendChild(banner);
  }

  function haptic(kind) {
    try {
      var h = tg && tg.HapticFeedback;
      if (h) h.notificationOccurred(kind);
    } catch (e) { /* optional */ }
  }

  // A background re-render would destroy the focused input and close the keyboard.
  // While a text field has focus, only mark the render as pending.
  var renderPending = false, pendingTimer = null;
  function fieldFocused() {
    var a = document.activeElement;
    return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && root.contains(a));
  }
  function render() {
    if (screen === 'progress') return; // the progress view owns the page
    if (fieldFocused()) { renderPending = true; return; }
    renderNow();
  }
  root.addEventListener('focusout', function (e) {
    if (!renderPending) return;
    var next = e.relatedTarget;
    if (next && (next.tagName === 'INPUT' || next.tagName === 'TEXTAREA') && root.contains(next)) return;
    // short delay: a tap on «Зберегти» must reach its button before the DOM is rebuilt
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () {
      if (renderPending && !fieldFocused()) renderNow();
    }, 250);
  });

  function renderNow() {
    renderPending = false;
    clearTimeout(pendingTimer);
    if (screen === 'progress') return;
    root.textContent = '';
    if (screen === 'client' && cstate && cstateDate !== today()) {
      cstate.today = {}; cstate.measuresToday = {}; cstate.sessionNote = '';
      cstateDate = today();
      sync(); // past midnight: refresh «минулого разу»
    }
    if (screen === 'client') renderClient(); else renderList();
  }

  // ---------- screen 1: client list ----------
  function renderList() {
    renderRejected();
    if (notice && !clients) {
      root.appendChild(messageBlock(notice.text, notice.retry));
      renderBar();
      return;
    }
    if (!clients) {
      root.appendChild(messageBlock('Завантаження…'));
      renderBar();
      return;
    }
    renderBanner();
    var search = document.createElement('input');
    search.type = 'search';
    search.className = 'search';
    search.placeholder = 'Пошук клієнта';
    search.setAttribute('autocomplete', 'off');
    search.value = query;
    root.appendChild(search);
    var list = el('div', 'list');
    root.appendChild(list);
    function fill() {
      list.textContent = '';
      var shown = C.filterClients(clients, query);
      if (!shown.length) {
        list.appendChild(el('div', 'message', clients.length ? 'Нікого не знайдено.' : 'Клієнтів поки немає.'));
        return;
      }
      shown.forEach(function (c) {
        var row = el('button', 'client-row');
        row.type = 'button';
        row.appendChild(el('span', 'client-name', c.name));
        var d = el('span', 'client-date' + (c.absent ? ' absent' : ''),
          (c.absent ? '⚠ ' : '') + (c.lastDate ? C.formatShortDate(c.lastDate) : 'ще не було'));
        row.appendChild(d);
        row.addEventListener('click', function () { openClient(c.name); });
        list.appendChild(row);
      });
    }
    search.addEventListener('input', function () { query = search.value; fill(); });
    fill();
    renderBar();
  }

  function openClient(name) {
    screen = 'client';
    clientName = name;
    cstate = loadCached(name);
    cstateDate = today();
    tab = 'train'; selected = null; openKey = null; draft = null; confirmKey = null;
    noteEdit = false; sessionDraft = null;
    notice = null;
    renderNow();
    sync();
  }

  function backToList() {
    screen = 'list';
    clientName = null; cstate = null;
    openKey = null; draft = null; confirmKey = null; noteEdit = false; sessionDraft = null;
    notice = null;
    renderNow();
    sync();
  }

  function openProgress() {
    if (!window.TLProgress) return;
    screen = 'progress';
    root.textContent = '';
    window.TLProgress.open({
      root: root, client: clientName, today: today(),
      onBack: function () { screen = 'client'; renderNow(); sync(); }
    });
  }

  // ---------- screen 2: client ----------
  function renderClient() {
    var head = el('div', 'head');
    head.appendChild(button('back', '← ' + clientName, backToList));
    if (window.TLProgress) head.appendChild(button('btn', 'Прогрес', openProgress));
    root.appendChild(head);
    renderRejected();

    if (notice && (!cstate || (notice.blocking && !N.queue().length))) {
      root.appendChild(messageBlock(notice.text, notice.retry));
      renderBar();
      return;
    }
    if (!cstate) {
      root.appendChild(messageBlock('Завантаження…'));
      renderBar();
      return;
    }
    renderBanner();

    var view = C.viewClient(cstate, N.queue(), clientName, today());
    renderNote(view);

    var seg = el('div', 'seg');
    [['train', 'Тренування'], ['measure', 'Заміри']].forEach(function (t) {
      var b = el('button', 'tab' + (tab === t[0] ? ' active' : ''), t[1]);
      b.type = 'button';
      b.addEventListener('click', function () {
        tab = t[0]; openKey = null; draft = null; confirmKey = null;
        renderNow();
      });
      seg.appendChild(b);
    });
    root.appendChild(seg);

    if (tab === 'train') renderTrain(view); else renderMeasures(view);
    renderBar();
  }

  function renderNote(view) {
    var n = view.clientNote;
    if (noteEdit) {
      var box = el('div', 'note-edit');
      var ta = document.createElement('textarea');
      ta.className = 'area';
      ta.maxLength = 2000;
      ta.value = noteDraft;
      ta.setAttribute('aria-label', 'Постійна нотатка');
      ta.addEventListener('input', function () { noteDraft = ta.value; });
      box.appendChild(ta);
      var btns = el('div', 'btns');
      btns.appendChild(button('btn', 'Зберегти', function () {
        clearTimeout(pendingTimer);
        noteEdit = false;
        enqueue({ kind: 'clientNote', date: today(), client: clientName, text: ta.value.trim() });
        afterSave();
      }));
      btns.appendChild(button('btn secondary', 'Скасувати', function () { noteEdit = false; renderNow(); }));
      box.appendChild(btns);
      root.appendChild(box);
      return;
    }
    var d = el('div', 'note' + (n.text ? '' : ' empty'), (n.pending ? '⏳ ' : '') + (n.text || 'Постійна нотатка: дотик, щоб додати'));
    d.setAttribute('role', 'button');
    d.tabIndex = 0;
    function edit() { noteEdit = true; noteDraft = n.text; renderNow(); }
    d.addEventListener('click', edit);
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); edit(); }
    });
    root.appendChild(d);
  }

  // After a save: show the pending state at once, then try to send.
  function afterSave() {
    renderNow();
    haptic('success');
    N.flush().then(function (r) {
      notice = flushNotice(r.failed);
      render();
    });
  }

  function lastText(entryText, date) {
    if (!entryText) return 'минулого разу: —';
    return 'минулого разу: ' + entryText + ' (' + C.formatShortDate(date) + ')';
  }

  function inputSeconds(s) {
    if (s < 60) return String(s);
    var sec = s % 60;
    return Math.floor(s / 60) + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function field(label, mode, key, value, cls, hint) {
    var wrap = el('div', 'field' + (cls ? ' ' + cls : ''));
    var id = 'f-' + key;
    var lab = el('label', null, label);
    lab.setAttribute('for', id);
    var inp = document.createElement('input');
    inp.id = id;
    inp.type = 'text';
    inp.setAttribute('inputmode', mode);
    inp.setAttribute('autocomplete', 'off');
    if (hint) inp.placeholder = hint;
    inp.value = value;
    inp.addEventListener('input', function () {
      draft[key] = inp.value;
      inp.classList.remove('invalid');
    });
    wrap.appendChild(lab);
    wrap.appendChild(inp);
    return { wrap: wrap, input: inp };
  }

  function currentWorkout() {
    var names = cstate.program.map(function (p) { return p.workout; });
    if (selected && names.indexOf(selected) !== -1) return selected;
    selected = names[0];
    return selected;
  }

  // row with a result, optional delete bar and form; shared by exercises and measures
  function buildItem(o) {
    var item = el('div', 'item');
    var row = el('div', 'row');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    var isOpen = openKey === o.key;
    row.appendChild(el('div', 'mark' + (o.done ? ' done' : ''), o.mark || (isOpen ? '▾' : '▸')));
    var main = el('div', 'main');
    main.appendChild(el('div', 'name', o.name));
    main.appendChild(el('div', 'sub', o.sub));
    row.appendChild(main);
    if (o.res) row.appendChild(el('div', 'res', o.res));
    function toggle() {
      if (isOpen) { openKey = null; draft = null; }
      else { openKey = o.key; draft = o.initialDraft(); confirmKey = null; }
      renderNow();
    }
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    item.appendChild(row);
    if (o.canDelete) item.appendChild(deleteBar(o));
    if (isOpen) item.appendChild(o.renderForm());
    return item;
  }

  function deleteBar(o) {
    var bar = el('div', 'delbar');
    if (confirmKey === o.key) {
      bar.appendChild(el('span', 'q', 'Видалити запис?'));
      bar.appendChild(button('linkbtn danger', 'Так', function () {
        confirmKey = null;
        if (openKey === o.key) { openKey = null; draft = null; }
        enqueue(o.deleteItem());
        afterSave();
      }));
      bar.appendChild(button('linkbtn plain', 'Ні', function () { confirmKey = null; renderNow(); }));
    } else {
      bar.appendChild(button('linkbtn', 'Видалити', function () { confirmKey = o.key; renderNow(); }));
    }
    return bar;
  }

  function saveButton(submit, inputs) {
    var btn = button('save', 'Зберегти', submit);
    inputs.forEach(function (f) {
      f.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });
    return btn;
  }

  // ----- workouts -----
  function renderTrain(view) {
    if (!cstate.program.length) {
      root.appendChild(messageBlock('Програма порожня. Додайте вправи клієнту на аркуші «Програма» в таблиці.'));
    } else {
      var wk = currentWorkout();
      var tabs = el('div', 'tabs');
      cstate.program.forEach(function (p) {
        var b = el('button', 'tab' + (p.workout === wk ? ' active' : ''), p.workout);
        b.type = 'button';
        b.addEventListener('click', function () {
          selected = p.workout; openKey = null; draft = null; confirmKey = null;
          renderNow();
        });
        tabs.appendChild(b);
      });
      root.appendChild(tabs);
      var program = cstate.program.filter(function (p) { return p.workout === wk; })[0];
      var list = el('div', 'list');
      program.exercises.forEach(function (x) { list.appendChild(exerciseItem(x, view, wk)); });
      root.appendChild(list);
    }
    renderSessionNote(view);
  }

  function exerciseItem(x, view, wk) {
    var name = x.name, isTime = x.type === 'час';
    var v = view.exercises[name];
    var last = (cstate.last || {})[name];
    var lastLine = lastText(last ? C.formatEntry(last) : '', last && last.date);
    var o = {
      key: 'ex|' + name, name: name,
      sub: v.deleting ? 'видалення очікує відправки' : (v.pending ? 'очікує відправки' : lastLine),
      mark: v.pending ? '⏳' : (v.entry ? '✓' : ''),
      done: !!(v.entry && !v.pending),
      res: v.entry ? C.formatEntry(v.entry) : '',
      canDelete: !!v.entry,
      deleteItem: function () { return { kind: 'deleteExercise', date: today(), client: clientName, exercise: name }; },
      initialDraft: function () {
        var src = v.entry || last;
        if (!src) return { w: '', r: '', s: '', t: '' };
        return {
          w: src.weight === null || src.weight === '' || src.weight === undefined ? '' : String(src.weight).replace('.', ','),
          r: src.reps ? String(src.reps) : '',
          s: String(src.sets),
          t: src.seconds ? inputSeconds(src.seconds) : ''
        };
      }
    };
    o.renderForm = function () {
      var form = el('div', 'form');
      var fields = el('div', 'fields');
      var fw, fr, ft, fs, all;
      if (isTime) {
        ft = field('час', 'text', 't', draft.t, null, 'сек або хв:сек');
        fs = field('підх.', 'numeric', 's', draft.s);
        all = [ft, fs];
      } else {
        fw = field('кг', 'decimal', 'w', draft.w);
        fr = field('повт.', 'numeric', 'r', draft.r);
        fs = field('підх.', 'numeric', 's', draft.s);
        all = [fw, fr, fs];
      }
      all.forEach(function (f) { fields.appendChild(f.wrap); });
      form.appendChild(fields);
      function submit() {
        var s = C.parseCount(fs.input.value, 100);
        var item = { kind: 'exercise', date: today(), client: clientName, workout: wk, exercise: name, weight: '', reps: '', seconds: '', sets: s };
        var bad;
        fs.input.classList.toggle('invalid', s === null);
        if (isTime) {
          var t = C.parseSeconds(ft.input.value);
          ft.input.classList.toggle('invalid', t === null);
          bad = s === null || t === null;
          item.seconds = t;
        } else {
          var w = C.parseWeight(fw.input.value);
          var r = C.parseCount(fr.input.value, 1000);
          fw.input.classList.toggle('invalid', w === null);
          fr.input.classList.toggle('invalid', r === null);
          bad = s === null || w === null || r === null;
          item.weight = w; item.reps = r;
        }
        if (bad) {
          clearTimeout(pendingTimer); // keep the highlighted fields
          haptic('error');
          return;
        }
        openKey = null; draft = null;
        enqueue(item);
        afterSave();
      }
      form.appendChild(saveButton(submit, all));
      return form;
    };
    return buildItem(o);
  }

  function renderSessionNote(view) {
    var sn = view.sessionNote;
    var box = el('div', 'sessnote');
    box.appendChild(el('h3', null, 'Нотатка до заняття' + (sn.pending ? ' ⏳' : '')));
    var ta = document.createElement('textarea');
    ta.className = 'area';
    ta.maxLength = 1000;
    ta.setAttribute('aria-label', 'Нотатка до заняття');
    ta.value = sessionDraft === null ? sn.text : sessionDraft;
    ta.addEventListener('input', function () { sessionDraft = ta.value; });
    box.appendChild(ta);
    box.appendChild(button('save', 'Зберегти', function () {
      clearTimeout(pendingTimer);
      var text = (sessionDraft === null ? sn.text : sessionDraft).trim();
      sessionDraft = null;
      enqueue({ kind: 'sessionNote', date: today(), client: clientName, text: text });
      afterSave();
    }));
    root.appendChild(box);
  }

  // ----- measures -----
  function renderMeasures(view) {
    if (!cstate.measureTypes.length) {
      root.appendChild(messageBlock('Параметри замірів не задано. Додайте їх на аркуші «Види замірів» в таблиці.'));
      return;
    }
    var list = el('div', 'list');
    cstate.measureTypes.forEach(function (t) {
      var param = t.param;
      var v = view.measures[param];
      var last = (cstate.measuresLast || {})[param];
      var lastLine = lastText(last ? C.formatNumber(last.value) + ' ' + t.unit : '', last && last.date);
      var o = {
        key: 'm|' + param, name: param,
        sub: v.deleting ? 'видалення очікує відправки' : (v.pending ? 'очікує відправки' : lastLine),
        mark: v.pending ? '⏳' : (v.value !== null ? '✓' : ''),
        done: v.value !== null && !v.pending,
        res: v.value !== null ? C.formatNumber(v.value) + ' ' + t.unit : '',
        canDelete: v.value !== null,
        deleteItem: function () { return { kind: 'deleteMeasure', date: today(), client: clientName, param: param }; },
        initialDraft: function () {
          var src = v.value !== null ? v.value : (last ? last.value : null);
          return { v: src === null ? '' : String(src).replace('.', ',') };
        }
      };
      o.renderForm = function () {
        var form = el('div', 'form');
        var fields = el('div', 'fields');
        var f = field(t.unit || 'значення', 'decimal', 'v', draft.v, 'wide');
        fields.appendChild(f.wrap);
        form.appendChild(fields);
        function submit() {
          var n = C.parseWeight(f.input.value);
          var bad = n === null || !(n > 0);
          f.input.classList.toggle('invalid', bad);
          if (bad) { clearTimeout(pendingTimer); haptic('error'); return; }
          openKey = null; draft = null;
          enqueue({ kind: 'measure', date: today(), client: clientName, param: param, value: n });
          afterSave();
        }
        form.appendChild(saveButton(submit, [f]));
        return form;
      };
      list.appendChild(buildItem(o));
    });
    root.appendChild(list);
  }

  // ---------- start ----------
  try { if (tg) { tg.ready(); tg.expand(); } } catch (e) { /* not in Telegram */ }

  if (!mock && !initData) {
    root.appendChild(messageBlock(window.Telegram
      ? 'Відкрийте додаток через бота в Telegram.'
      : 'Не вдалося завантажити додаток. Перевірте зв\'язок і відкрийте його знову.'));
  } else if (!mock && !apiUrl) {
    root.appendChild(messageBlock('Не налаштовано: вкажіть адресу скрипта у config.js.'));
  } else {
    N.init({ apiUrl: apiUrl, initData: initData, mock: mock });
    mine = N.queue();
    var cachedList = N.cacheGet(K_CLIENTS);
    if (Array.isArray(cachedList)) clients = cachedList;
    N.onChange(function () { reconcile(); render(); });
    render();
    sync();
    // returning to the app: pick up changes and retry the queue
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !syncing) sync();
    });
    // connection is back while the app is open: send the queue (sync() is safe to call while a sync runs)
    window.addEventListener('online', function () { sync(); });
  }
})();
