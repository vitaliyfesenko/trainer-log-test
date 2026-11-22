// Progress screen: period + switches -> server-built message -> edit -> send/copy.
(function () {
  'use strict';
  var C = window.TLCore, N = window.TLNet;

  var PERIODS = [
    ['4w', '4 тижні'], ['3m', '3 місяці'], ['6m', 'півроку'], ['1y', 'рік'], ['all', 'весь час']
  ];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function errorText(code, res) {
    if (code === 'forbidden') {
      return 'У вас немає доступу. Ваш Telegram ID: ' + (res && res.userId) + '. Передайте його власнику щоденника.';
    }
    if (code === 'expired' || code === 'bad_signature') return 'Сеанс застарів. Закрийте й відкрийте додаток знову.';
    if (code === 'not_configured') return 'Скрипт не налаштовано: додайте BOT_TOKEN у властивості скрипта.';
    return 'Помилка сервера (' + code + '). Спробуйте ще раз.';
  }

  function isMock() {
    try { return /[?&]mock=/.test(location.search); } catch (e) { return false; }
  }

  function open(opts) {
    var root = opts.root, client = opts.client, onBack = opts.onBack;
    var period = '4w', withEx = true, withMe = true;
    var reqId = 0, dead = false;
    var currentText = '';

    root.textContent = '';
    var head = el('div', 'head');
    var back = el('button', 'back', '← Назад');
    back.type = 'button';
    back.addEventListener('click', function () { dead = true; reqId++; onBack(); });
    head.appendChild(back);
    root.appendChild(head);
    root.appendChild(el('h2', 'prog-title', 'Прогрес: ' + client));

    var periodBox = el('div', 'tabs');
    root.appendChild(periodBox);
    var switchBox = el('div', 'seg');
    root.appendChild(switchBox);
    var result = el('div', 'prog-result');
    root.appendChild(result);

    function toggle(label, on, set) {
      var b = el('button', 'tab' + (on ? ' active' : ''), label);
      b.type = 'button';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', function () { set(); drawControls(); load(); });
      return b;
    }

    function drawControls() {
      periodBox.textContent = '';
      PERIODS.forEach(function (p) {
        var b = el('button', 'tab' + (p[0] === period ? ' active' : ''), p[1]);
        b.type = 'button';
        b.setAttribute('aria-pressed', p[0] === period ? 'true' : 'false');
        b.addEventListener('click', function () {
          if (period === p[0]) return;
          period = p[0]; drawControls(); load();
        });
        periodBox.appendChild(b);
      });
      switchBox.textContent = '';
      switchBox.appendChild(toggle('Вправи', withEx, function () { withEx = !withEx; }));
      switchBox.appendChild(toggle('Заміри', withMe, function () { withMe = !withMe; }));
    }

    function showMessage(text, retry) {
      result.textContent = '';
      var box = el('div', 'message');
      box.appendChild(el('p', null, text));
      if (retry) {
        var b = el('button', 'btn', 'Повторити');
        b.type = 'button';
        b.addEventListener('click', load);
        box.appendChild(b);
      }
      result.appendChild(box);
    }

    async function load() {
      var id = ++reqId;
      showMessage('Рахую прогрес…');
      var res;
      try {
        res = await N.request({ action: 'progress', client: client, period: period, exercises: withEx, measures: withMe });
      } catch (e) {
        if (id === reqId && !dead) showMessage('Немає зв\'язку. Спробуйте ще раз.', true);
        return;
      }
      if (id !== reqId || dead) return; // stale: the choice changed meanwhile
      if (!res || !res.ok) {
        var code = (res && res.error) || 'server_error';
        var access = code === 'forbidden' || code === 'expired' || code === 'bad_signature' || code === 'not_configured';
        showMessage(errorText(code, res), !access);
        return;
      }
      if (res.text == null) { showMessage('За цей період прогресу немає'); return; }
      showText(String(res.text));
    }

    function showText(text) {
      currentText = text;
      result.textContent = '';
      var ta = document.createElement('textarea');
      ta.className = 'area prog-text';
      ta.setAttribute('aria-label', 'Текст повідомлення');
      ta.value = text;
      ta.addEventListener('input', function () { currentText = ta.value; });
      result.appendChild(ta);

      var status = el('div', 'prog-status');
      status.setAttribute('role', 'status');
      function say(msg) { status.textContent = msg; }

      var btns = el('div', 'prog-btns');
      var send = el('button', 'btn', 'Надіслати в Telegram');
      var copy = el('button', 'btn secondary', 'Скопіювати текст');
      send.type = 'button'; copy.type = 'button';
      btns.appendChild(send); btns.appendChild(copy);
      result.appendChild(btns);
      result.appendChild(status);

      function markSent() {
        N.enqueue({ kind: 'report', date: C.localDate(new Date()), client: client, period: period });
        try { var p = N.flush(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* queued anyway */ }
      }

      // must run inside the click handler (user gesture) for the clipboard
      function doCopy(okMsg) {
        var p;
        try {
          p = navigator.clipboard && navigator.clipboard.writeText
            ? navigator.clipboard.writeText(ta.value) : Promise.reject(new Error('no clipboard'));
        } catch (e) { p = Promise.reject(e); }
        p.then(function () { say(okMsg); }, function () {
          ta.focus(); ta.select();
          say('Виділено — скопіюйте вручну');
        });
      }

      copy.addEventListener('click', function () {
        doCopy('Скопійовано. Позначено як надіслане');
        markSent();
      });

      send.addEventListener('click', function () {
        var tg = window.Telegram && window.Telegram.WebApp;
        if (!isMock() && tg && typeof tg.openTelegramLink === 'function') {
          try {
            tg.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(ta.value));
            say('Позначено як надіслане');
            markSent();
            return;
          } catch (e) { /* fall through to copy */ }
        }
        doCopy('Telegram недоступний — текст скопійовано');
        markSent();
      });
    }

    drawControls();
    load();
  }

  window.TLProgress = { open: open };
})();
