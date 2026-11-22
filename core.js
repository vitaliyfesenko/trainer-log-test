(function () {
  var MONTHS = ['січ.', 'лют.', 'бер.', 'квіт.', 'трав.', 'черв.', 'лип.', 'серп.', 'вер.', 'жовт.', 'лист.', 'груд.'];

  function parseWeight(text) {
    var s = String(text).trim();
    if (s === '') return 0;
    if (!/^\d+([.,]\d+)?$/.test(s)) return null;
    var n = Number(s.replace(',', '.'));
    return n > 1000 ? null : n;
  }

  function parseCount(text, max) {
    var s = String(text).trim();
    if (!/^\d+$/.test(s)) return null;
    var n = Number(s);
    return n >= 1 && n <= max ? n : null;
  }

  // '90' -> 90, '1:30' -> 90; 1..36000, otherwise null.
  function parseSeconds(text) {
    var s = String(text).trim();
    var n;
    if (/^\d+$/.test(s)) {
      n = Number(s);
    } else {
      var m = /^(\d+):([0-5]\d)$/.exec(s);
      if (!m) return null;
      n = Number(m[1]) * 60 + Number(m[2]);
    }
    return n >= 1 && n <= 36000 ? n : null;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function localDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function formatShortDate(iso) {
    var p = iso.split('-');
    return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1];
  }

  // Same rules as formatNumberUk / formatSecondsUk in apps-script/progress.js.
  function formatNumber(n) {
    return String(Math.round(n * 100) / 100).replace('.', ',');
  }

  function formatSeconds(s) {
    if (s < 60) return s + ' с';
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var ss = pad(sec);
    if (h > 0) return h + ':' + pad(m) + ':' + ss;
    return m + ':' + ss;
  }

  function formatEntry(e) {
    if (e.type === 'час') return formatSeconds(e.seconds) + ' × ' + e.sets;
    return formatNumber(e.weight) + ' кг × ' + e.reps + ' × ' + e.sets;
  }

  function itemKey(item) {
    switch (item.kind) {
      case 'exercise':
      case 'deleteExercise': return 'ex|' + item.date + '|' + item.client + '|' + item.exercise;
      case 'measure':
      case 'deleteMeasure': return 'm|' + item.date + '|' + item.client + '|' + item.param;
      case 'sessionNote': return 'sn|' + item.date + '|' + item.client;
      case 'clientNote': return 'cn|' + item.client;
      case 'report': return 'r|' + item.date + '|' + item.client + '|' + item.period;
    }
    return String(item.kind);
  }

  function queueAdd(queue, item) {
    var key = itemKey(item);
    var out = queue.filter(function (q) { return itemKey(q) !== key; });
    out.push(item);
    return out;
  }

  async function flushQueue(queue, send) {
    var rest = queue.slice();
    while (rest.length) {
      var res;
      try {
        res = await send(rest[0]);
      } catch (e) {
        return { queue: rest, failed: 'network' };
      }
      if (res && res.ok) {
        rest.shift();
      } else if (res && res.error === 'invalid_entry') {
        rest.shift();
      } else {
        return { queue: rest, failed: (res && res.error) || 'server_error' };
      }
    }
    return { queue: rest, failed: null };
  }

  function viewClient(state, queue, client, today) {
    var mine = queue.filter(function (i) { return i.client === client; });
    var todays = mine.filter(function (i) { return i.date === today; });
    function last(kind, field, name) {
      var found = null;
      todays.forEach(function (i) { if (i.kind === kind && i[field] === name) found = i; });
      return found;
    }
    var exercises = {};
    (state.program || []).forEach(function (w) {
      w.exercises.forEach(function (x) {
        var name = x.name;
        var server = (state.today || {})[name];
        var view = { entry: server || null, pending: false, deleting: false };
        // The queue keeps one item per exercise key, so at most one of these matches.
        var sv = last('exercise', 'exercise', name);
        var del = last('deleteExercise', 'exercise', name);
        if (sv) {
          view = { entry: { workout: sv.workout, type: x.type, weight: sv.weight, reps: sv.reps, seconds: sv.seconds, sets: sv.sets }, pending: true, deleting: false };
        } else if (del) {
          view = { entry: null, pending: true, deleting: true };
        }
        exercises[name] = view;
      });
    });
    var measures = {};
    (state.measureTypes || []).forEach(function (t) {
      var server = (state.measuresToday || {})[t.param];
      var view = { value: server === undefined ? null : server, pending: false, deleting: false };
      var sv = last('measure', 'param', t.param);
      var del = last('deleteMeasure', 'param', t.param);
      if (sv) view = { value: sv.value, pending: true, deleting: false };
      else if (del) view = { value: null, pending: true, deleting: true };
      measures[t.param] = view;
    });
    var sn = null;
    todays.forEach(function (i) { if (i.kind === 'sessionNote') sn = i; });
    var cn = null;
    mine.forEach(function (i) { if (i.kind === 'clientNote') cn = i; });
    return {
      exercises: exercises,
      measures: measures,
      sessionNote: sn ? { text: sn.text, pending: true } : { text: state.sessionNote || '', pending: false },
      clientNote: cn ? { text: cn.text, pending: true } : { text: state.note || '', pending: false }
    };
  }

  function filterClients(list, query) {
    var q = String(query).trim().toLocaleLowerCase('uk');
    if (q === '') return list;
    return list.filter(function (c) { return String(c.name).toLocaleLowerCase('uk').indexOf(q) !== -1; });
  }

  var api = {
    parseWeight: parseWeight, parseCount: parseCount, parseSeconds: parseSeconds, localDate: localDate,
    formatShortDate: formatShortDate, formatSeconds: formatSeconds, formatNumber: formatNumber,
    formatEntry: formatEntry, itemKey: itemKey, queueAdd: queueAdd, flushQueue: flushQueue,
    viewClient: viewClient, filterClients: filterClients
  };
  globalThis.TLCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
