/* Юридический навигатор — логика лендинга.
 * Ассистент, каталог подсказок, поле «прислать на почту» и уведомление в n8n.
 */
(function () {
  'use strict';

  // ================================================================
  // НАСТРОЙКА — три адреса, всё остальное работает само
  // ================================================================

  // Ссылка на бота. После /newapp в BotFather сюда можно поставить прямую
  // ссылку вида https://t.me/<bot>/<short_name>?startapp=site — тогда мини-апп
  // откроется одним касанием, без промежуточного /start.
  var TG_LINK = 'https://t.me/tg_crm_vibecoder_bot?start=site';

  // Production Chat URL основного workflow. Пусто — работает демо-режим на
  // записанных ответах, каждый из которых прошёл настоящие Code-ноды n8n.
  var CHAT_URL = 'https://n8n-production-5b17.up.railway.app/webhook/00003039-167e-4800-a800-00007f790800/chat';

  // Production URL workflow «уведомление на почту». Пусто — письма не шлются.
  // Письмо вам и автоответ клиенту отправляет сам процесс после каждого
  // ответа, поэтому отдельный вызов с сайта больше не нужен.
  var NOTIFY_URL = '';

  var LIMIT_PER_HOUR = 15;
  var MAX_LEN = 500;

  // ================================================================

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = String(html).trim();
    return t.content.firstElementChild;
  }
  function money(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

  ['tg-top', 'tg-hero', 'tg-mini', 'tg-final'].forEach(function (id) {
    var a = $(id);
    if (a) { a.href = TG_LINK; a.target = '_blank'; a.rel = 'noopener'; }
  });

  // ---------- появление при прокрутке ----------
  // Анимация появления — украшение, но она держит opacity:0 на ВСЕЙ странице.
  // Значит любая причина, по которой наблюдатель не сработает (вкладка открыта
  // в фоне, страница не отрисована, экзотический браузер), оставит посетителя
  // перед пустым экраном. Поэтому здесь три независимых способа показать
  // содержимое, и достаточно любого одного.
  var revs = document.querySelectorAll('.rev');
  function revealAll() {
    [].forEach.call(revs, function (n) { n.classList.add('in'); });
  }

  if (window.IntersectionObserver) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    [].forEach.call(revs, function (n) { io.observe(n); });

    // Страховка 1: если через полторы секунды первый экран всё ещё невидим,
    // наблюдатель не отработал — показываем всё без анимации.
    setTimeout(function () {
      var first = document.querySelector('.hero .rev');
      if (first && !first.classList.contains('in')) revealAll();
    }, 1500);

    // Страховка 2: первая же прокрутка снимает вопрос окончательно.
    window.addEventListener('scroll', function once() {
      window.removeEventListener('scroll', once);
      setTimeout(function () {
        var vis = document.querySelectorAll('.rev.in').length;
        if (vis < 3) revealAll();
      }, 300);
    }, { passive: true, once: true });
  } else {
    revealAll();
  }

  var top = $('top');
  window.addEventListener('scroll', function () {
    if (top) top.classList.toggle('stuck', window.scrollY > 24);
  }, { passive: true });

  // ---------- состояние ----------
  var thread = $('thread');
  var form = $('form');
  var input = $('input');
  var sendBtn = $('send');
  var modeLabel = $('mode');
  var invite = thread.querySelector('.invite');
  var chipsBox = $('chips');
  var busy = false;
  var demoData = null;
  var catalogue = null;
  var asked = {};
  var sessionId = 'site-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  var CHIPS = [
    { q: 'До какой суммы договор можно подписать без визы юр. отдела?', n: 'ветка А — знает и отвечает' },
    { q: 'Подготовь запрос на согласование договора с поставщиком на 8000 евро', n: 'ветка Б — нужно подтверждение' },
    { q: 'Можно ли мне подписать NDA по законам штата Калифорния?', n: 'ветка В — этого в документе нет' },
    { q: 'Что делать при получении претензии?', n: 'чеклист из приложения Б' }
  ];
  var BRANCH = {
    A: { t: 'a', l: 'А', n: 'прямой ответ' },
    B: { t: 'b', l: 'Б', n: 'требуется подтверждение' },
    V: { t: 'v', l: 'В', n: 'передано юристу' }
  };

  // Прокручиваем к НАЧАЛУ нового блока, а не в самый низ: иначе длинный ответ
  // с графиком открывается на своём хвосте и текста не видно.
  function toBlock(node) {
    requestAnimationFrame(function () {
      if (node && node.offsetTop) thread.scrollTop = Math.max(node.offsetTop - 14, 0);
      else thread.scrollTop = thread.scrollHeight;
    });
  }
  function toEnd() { toBlock(null); }

  // ---------- лимит с одного браузера ----------
  function quotaLeft() {
    try {
      var r = JSON.parse(localStorage.getItem('ln-quota') || '{}');
      if (r.hour !== new Date().getHours()) return LIMIT_PER_HOUR;
      return Math.max(0, LIMIT_PER_HOUR - (r.used || 0));
    } catch (e) { return LIMIT_PER_HOUR; }
  }
  function quotaUse() {
    try {
      var h = new Date().getHours();
      var r = JSON.parse(localStorage.getItem('ln-quota') || '{}');
      localStorage.setItem('ln-quota', JSON.stringify({ hour: h, used: (r.hour === h ? (r.used || 0) : 0) + 1 }));
    } catch (e) {}
  }

  // ---------- визуализация ----------
  function visual(v) {
    if (!v || !v.type || v.type === 'none') return '';
    try {
      if (v.type === 'threshold_bar') {
        var items = v.items || [];
        return '<div class="vis"><p class="vis-t"><span>' + esc(v.title) + '</span><span>' + esc(v.source_ref) + ' · стр. ' + esc(v.source_page) + '</span></p>' +
          (v.marker ? '<div class="mark">' + esc(v.marker.label) + '</div>' : '') +
          '<div class="ladder">' + items.map(function (i) {
            return '<div class="' + (i.label === v.highlight ? 'on' : 'off') + '"></div>';
          }).join('') + '</div>' +
          '<div class="scale">' + items.map(function (i) {
            return '<span>' + esc(i.max == null ? '∞' : money(i.max)) + '</span>';
          }).join('') + '</div>' +
          items.map(function (i) {
            return '<div class="tier' + (i.label === v.highlight ? ' on' : '') + '">' +
              '<b>' + esc(i.label) + '</b><span>' + esc(i.signer) + '</span>' +
              '<span>Виза: ' + esc(i.visa) + '</span></div>';
          }).join('') + '</div>';
      }
      if (v.type === 'table') {
        return '<div class="vis"><p class="vis-t"><span>' + esc(v.title) + '</span><span>' + esc(v.source_ref) + ' · стр. ' + esc(v.source_page) + '</span></p>' +
          '<div class="tw"><table><thead><tr>' +
          (v.head || []).map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          (v.rows || []).map(function (r) {
            return '<tr' + (v.highlight && r[0] === v.highlight ? ' class="on"' : '') + '>' +
              r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table></div></div>';
      }
      if (v.type === 'checklist') {
        return '<div class="vis"><p class="vis-t"><span>' + esc(v.title) + '</span><span>' + esc(v.source_ref) + ' · стр. ' + esc(v.source_page) + '</span></p>' +
          (v.items || []).map(function (i) { return '<div class="tier"><b>' + esc(i) + '</b></div>'; }).join('') + '</div>';
      }
    } catch (e) { return ''; }
    return '';
  }

  // ---------- уведомление на почту ----------
  // Вызывается ПОСЛЕ показа ответа и результата не ждёт: письмо не должно
  // задерживать интерфейс. Ошибку глотаем — почта не критична для ответа.
  // Письмо содержит ровно тот ответ, который человек прочитал на экране:
  // отправляем его вместе с запросом и флагом mail_only. Переспрашивать агента
  // нельзя — он может ответить иначе, и в письме окажется не то.
  function notify(payload) {
    if (!CHAT_URL) return Promise.resolve(false);
    return fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sendMessage',
        mail_only: true,
        chatInput: payload.question,
        question: payload.question,
        answer: payload.answer,
        branch: payload.branch,
        source: payload.source,
        confidence: payload.confidence,
        sessionId: payload.session,
        channel: 'сайт',
        reply_to: payload.reply_to
      })
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  function mailRow(data) {
    var row = el('<div class="mailrow">' +
      '<input type="email" placeholder="Прислать ответ на почту" autocomplete="email">' +
      '<button type="button">Отправить</button>' +
      '<p class="hint">Письмо придёт один раз, на указанный адрес. Ассистент не даёт юридических консультаций.</p>' +
      '</div>');
    var field = row.querySelector('input');
    var btn = row.querySelector('button');

    btn.addEventListener('click', function () {
      var mail = field.value.trim().toLowerCase();
      if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(mail)) {
        field.focus();
        field.style.borderColor = 'var(--v)';
        return;
      }
      field.style.borderColor = '';
      btn.disabled = true;
      btn.textContent = 'Отправляем…';

      notify({
        question: data.question, answer: data.answer, branch: data.branch,
        source: data.source, channel: 'сайт', confidence: data.confidence,
        session: sessionId, reply_to: mail
      }).then(function (ok) {
        // Процесс подтверждает приём до фактической отправки письма,
        // поэтому обещаем отправку, а не доставку.
        row.innerHTML = ok
          ? '<p class="done">Готово — ответ уйдёт на ' + esc(mail) + '.</p>'
          : '<p class="hint">Не удалось передать заявку. Попробуйте ещё раз позже.</p>';
      });
    });
    return row;
  }

  function addAnswer(d) {
    var b = BRANCH[d.branch] || { t: 'a', l: '·', n: 'ответ' };
    var html = '<div class="ans"><div class="ans-head"><span class="tag2 ' + b.t + '">' + esc(b.l) + '</span>' + esc(b.n) +
      (typeof d.confidence === 'number' ? ' · ' + d.confidence.toFixed(2) : '') + '</div>' +
      '<div class="ans-body">' + esc(d.output || d.answer || '') + '</div>';
    if (d.source_summary) html += '<div class="cite">' + esc(d.source_summary) + '</div>';
    html += visual(d.visual);
    if (d.status === 'pending_approval') {
      html += '<div class="notice wait">Письмо не отправлено. Решение принимает человек в Telegram.</div>';
    } else if (d.status === 'escalated' && d.reason_no_answer) {
      html += '<div class="notice esc">' + esc(d.reason_no_answer) + '</div>';
    }

    var card = el(html + '</div>');
    card.appendChild(mailRow({
      question: d.__q || '', answer: d.answer || d.output || '',
      branch: d.branch, source: d.source_summary, confidence: d.confidence
    }));
    thread.appendChild(card);
    toBlock(card);

    var ref = (d.source_summary || '').match(/§\s*\d{1,2}(?:\.\d)?|Приложение\s+[АБ](?:\.\d)?/);
    renderFollowUps(ref ? ref[0].replace(/\s+/g, ' ').replace('§ ', '§') : null);
  }

  function addError(t) {
    thread.appendChild(el('<div class="notice err">' + esc(t) + '</div>'));
    toEnd();
  }

  // ---------- каталог подсказок ----------
  function normalizeQ(q) { return String(q).toLowerCase().replace(/[^а-яёa-z0-9]+/g, ' ').trim(); }

  function searchCatalogue(query, limit) {
    if (!catalogue) return [];
    var words = normalizeQ(query).split(' ').filter(function (w) { return w.length >= 3; });
    if (!words.length) return [];
    var hits = [];
    catalogue.items.forEach(function (it) {
      if (asked[it.q]) return;
      var ok = words.every(function (w) { return it.kw.indexOf(w) !== -1; });
      if (ok) hits.push(it);
    });
    return hits.slice(0, limit || 6);
  }

  function followUps(ref, limit) {
    if (!catalogue) return [];
    var seen = {}, near = [], far = [];
    (catalogue.byRef[ref] || []).forEach(function (i) {
      var it = catalogue.items[i];
      if (it && !asked[it.q] && !seen[it.q] && near.length < 2) { seen[it.q] = 1; near.push(it); }
    });
    var refs = Object.keys(catalogue.byRef).filter(function (r) { return r !== ref; });
    for (var i = refs.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = refs[i]; refs[i] = refs[j]; refs[j] = t;
    }
    for (var r = 0; r < refs.length && far.length < 3; r++) {
      var idxs = catalogue.byRef[refs[r]];
      var c = catalogue.items[idxs[Math.floor(Math.random() * idxs.length)]];
      if (c && !asked[c.q] && !seen[c.q]) { seen[c.q] = 1; far.push(c); }
    }
    return near.concat(far).slice(0, limit || 3);
  }

  // Лента листается пальцем сама; на десктопе добавляем перетаскивание мышью,
  // иначе без горизонтального колеса до дальних карточек не добраться.
  function makeDraggable(row) {
    var down = false, startX = 0, startLeft = 0, moved = 0;
    row.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return;   // на тач-экране работает нативно
      down = true; moved = 0;
      startX = e.clientX; startLeft = row.scrollLeft;
      row.classList.add('dragging');
    });
    row.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - startX;
      moved = Math.max(moved, Math.abs(dx));
      row.scrollLeft = startLeft - dx;
    });
    var stop = function () {
      if (!down) return;
      down = false;
      row.classList.remove('dragging');
      // После перетаскивания клик по карточке гасим, иначе уедет вопрос,
      // который пользователь просто пролистывал.
      if (moved > 6) {
        row.addEventListener('click', function once(ev) {
          ev.stopPropagation(); ev.preventDefault();
          row.removeEventListener('click', once, true);
        }, true);
      }
    };
    row.addEventListener('pointerup', stop);
    row.addEventListener('pointerleave', stop);
    row.addEventListener('pointercancel', stop);
  }

  /** Собирает горизонтальную ленту карточек-подсказок. */
  function buildRow(items) {
    var row = document.createElement('div');
    row.className = 'srow';
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = esc(it.q) + '<i>' + esc(it.ref) + '</i>';
      b.addEventListener('click', function () { ask(it.q); });
      row.appendChild(b);
    });
    makeDraggable(row);
    return row;
  }

  function renderFollowUps(ref) {
    var list = followUps(ref, 6);
    if (!list.length) return;
    var box = el('<div class="followups"><p class="fu-title">Спросить дальше' +
      '<em>' + list.length + ' · листайте вбок</em></p></div>');
    box.appendChild(buildRow(list));
    thread.appendChild(box);
    toEnd();
  }

  function renderSuggest(query) {
    var box = $('suggest');
    if (!box) return;
    var hits = query.trim().length >= 2 ? searchCatalogue(query, 10) : [];
    if (!hits.length) { box.hidden = true; box.innerHTML = ''; return; }

    box.innerHTML = '<p class="sg-title">Подсказки по справочнику' +
      '<em>найдено ' + hits.length + ' · листайте вбок</em></p>';
    var row = document.createElement('div');
    row.className = 'srow';
    hits.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = esc(it.q) + '<i>' + esc(it.ref) + '</i>';
      b.addEventListener('click', function () {
        input.value = ''; box.hidden = true; ask(it.q);
      });
      row.appendChild(b);
    });
    makeDraggable(row);
    box.appendChild(row);
    box.hidden = false;
  }

  // ---------- источники ответов ----------
  function loadDemo() {
    if (demoData) return Promise.resolve(demoData);
    return fetch('demo-responses.json').then(function (r) { return r.json(); })
      .then(function (d) { demoData = d; return d; });
  }
  function fromDemo(q) {
    return loadDemo().then(function (d) {
      for (var i = 0; i < d.items.length; i++) {
        if (new RegExp(d.items[i].match, 'i').test(q)) return d.items[i].response;
      }
      if (catalogue) {
        var norm = normalizeQ(q);
        for (var k = 0; k < catalogue.items.length; k++) {
          if (normalizeQ(catalogue.items[k].q) === norm) return catalogue.items[k].response;
        }
        var f = searchCatalogue(q, 1);
        if (f.length) return f[0].response;
      }
      return d.fallback;
    });
  }
  function fromN8n(q) {
    return fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sendMessage', sessionId: sessionId, chatInput: q })
    }).then(function (r) {
      var type = r.headers.get('content-type') || '';
      if (type.indexOf('application/json') === -1) throw new Error('not json');
      return r.json();
    });
  }

  function ask(q) {
    if (busy) return;
    q = String(q || '').trim();
    if (!q) return;
    if (q.length > MAX_LEN) { addError('Вопрос длиннее ' + MAX_LEN + ' символов.'); return; }
    if (CHAT_URL && quotaLeft() <= 0) {
      addError('На этот час вопросов с этого браузера достаточно. Продолжите в Telegram — там ограничений нет.');
      return;
    }

    busy = true;
    sendBtn.disabled = true;
    asked[q] = 1;
    if (invite) { invite.remove(); invite = null; }
    if (chipsBox) { chipsBox.remove(); chipsBox = null; }
    var sg = $('suggest'); if (sg) { sg.hidden = true; sg.innerHTML = ''; }

    thread.appendChild(el('<div class="bubble">' + esc(q) + '</div>'));
    var pending = el('<div class="ans"><div class="dots"><i></i><i></i><i></i></div></div>');
    thread.appendChild(pending);
    toEnd();

    var run;
    if (CHAT_URL) {
      quotaUse();
      run = fromN8n(q).catch(function () { return fromDemo(q); });
    } else {
      run = fromDemo(q);
    }

    run.then(function (d) {
      pending.remove();
      if (!d) { addError('Не удалось получить ответ.'); return; }
      if (d.error) { addError(d.error); return; }
      d.__q = q;
      addAnswer(d);
      // Письмо вам отправляет сам процесс — и только по веткам Б и В.
      // Раньше здесь был повторный вызов, из-за которого на каждый вопрос
      // запускался второй прогон с агентом и приходило два письма.
    }).catch(function () {
      pending.remove();
      addError('Ассистент недоступен. Попробуйте в Telegram.');
    }).finally(function () {
      busy = false;
      sendBtn.disabled = false;
    });
  }

  CHIPS.forEach(function (c) {
    var b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = esc(c.q) + '<i>' + esc(c.n) + '</i>';
    b.addEventListener('click', function () { ask(c.q); });
    chipsBox.appendChild(b);
  });
  makeDraggable(chipsBox);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = input.value;
    input.value = '';
    ask(v);
  });
  input.addEventListener('input', function () { renderSuggest(input.value); });
  input.addEventListener('focus', function () { renderSuggest(input.value); });
  input.addEventListener('blur', function () {
    setTimeout(function () { var b = $('suggest'); if (b) b.hidden = true; }, 180);
  });

  fetch('catalogue.json').then(function (r) { return r.json(); })
    .then(function (c) { catalogue = c; })
    .catch(function () { catalogue = null; });

  if (modeLabel) modeLabel.textContent = CHAT_URL ? 'живой' : 'демо';
})();

/* ================================================================
   КАРТОТЕКА ЗАЯВОК
   ================================================================
   Заявки хранятся в самом процессе n8n. Здесь только показ и смена статуса.

   Ключ доступа не зашит в страницу: она публичная, а в заявках лежат вопросы
   и почтовые адреса клиентов. Ключ вводится один раз и хранится в браузере
   того, кто его ввёл.

   Секция открывается по адресу с #crm — ссылка есть в подвале. */
(function () {
  'use strict';

  var CRM_URL = 'https://n8n-production-5b17.up.railway.app/webhook/crm-7f3a91c2';
  var STATUS = [
    { key: 'new', label: 'Новая' },
    { key: 'work', label: 'В работе' },
    { key: 'done', label: 'Закрыта' }
  ];

  var section = document.getElementById('crm');
  var root = document.getElementById('crm-root');
  if (!section || !root) return;

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function key() { try { return localStorage.getItem('crm-key') || ''; } catch (e) { return ''; } }
  function setKey(v) { try { localStorage.setItem('crm-key', v); } catch (e) {} }

  function lock(msg) {
    root.innerHTML = '<p class="crm-empty">' + esc(msg || 'Введите ключ доступа.') + '</p>' +
      '<div class="crm-gate"><input type="password" id="crm-key" placeholder="Ключ доступа" autocomplete="off">' +
      '<button type="button" id="crm-unlock">Открыть</button></div>';
  }

  function card(r) {
    var st = STATUS.filter(function (s) { return s.key === r.status; })[0] || STATUS[0];
    var acts = STATUS.map(function (s) {
      return '<button type="button" data-id="' + esc(r.id) + '" data-status="' + s.key + '"' +
        (s.key === r.status ? ' class="on"' : '') + '>' + s.label + '</button>';
    }).join('');
    return '<article class="crm-card">' +
      '<div class="crm-top"><span class="pill ' + st.key + '">' + st.label + '</span>' +
      (r.needs_human ? '<span class="pill work">нужен человек</span>' : '') +
      '<span class="crm-id">№ ' + esc(r.id) + ' · ' + esc(r.channel || '') + '</span></div>' +
      '<p class="crm-q">' + esc(r.question) + '</p>' +
      '<p class="crm-a">' + esc(r.answer) + '</p>' +
      '<p class="crm-src">' + esc(r.branch_label || '') +
        (r.source ? ' · ' + esc(r.source) : '') +
        (r.reply_to ? ' · почта клиента: ' + esc(r.reply_to) : '') + '</p>' +
      '<div class="crm-acts">' + acts + '</div>' +
      '</article>';
  }

  // Показывать всё или только то, где нужен человек. Уведомления и так приходят
  // только по веткам Б и В, но в журнале лежат все обращения — фильтр даёт
  // увидеть ровно то, с чем надо что-то делать.
  var onlyHuman = false;
  var lastData = null;

  function render(d) {
    lastData = d;
    if (!d.items.length) {
      root.innerHTML = '<p class="crm-empty">Пока пусто. Задайте вопрос ассистенту выше — заявка появится здесь.</p>';
      return;
    }
    var items = onlyHuman ? d.items.filter(function (r) { return r.needs_human; }) : d.items;
    var attention = d.items.filter(function (r) { return r.needs_human; }).length;

    root.innerHTML =
      '<div class="crm-head"><span class="crm-count">Всего ' + d.total +
        ' · новых ' + d.counts.new + ' · в работе ' + d.counts.work + ' · закрыто ' + d.counts.done +
        ' · требуют внимания ' + attention + '</span>' +
        '<button type="button" class="crm-btn" id="crm-filter">' +
          (onlyHuman ? 'Показать все' : 'Только требующие внимания') + '</button>' +
        '<button type="button" class="crm-btn" id="crm-reload">Обновить</button></div>' +
      (items.length
        ? '<div class="crm-list">' + items.map(card).join('') + '</div>'
        : '<p class="crm-empty">Обращений, требующих человека, нет. Все вопросы закрыты прямым ответом по документу.</p>');
  }

  function load(change) {
    var k = key();
    if (!k) { lock('Картотека закрыта: в заявках есть адреса клиентов.'); return; }

    // Только GET: у вебхука объявлены оба метода, и в этом режиме n8n отвечает
    // через Respond-ноду лишь на GET — POST возвращает пустое тело.
    var url = CRM_URL + '?key=' + encodeURIComponent(k);
    if (change) {
      url += '&action=status&id=' + encodeURIComponent(change.id) +
        '&status=' + encodeURIComponent(change.status);
    }
    fetch(url, { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d) throw new Error('пусто');
        if (d.locked) { lock('Ключ не подошёл. Попробуйте ещё раз.'); return; }
        if (!d.items) throw new Error('пусто');
        render(d);
      })
      .catch(function () {
        root.innerHTML = '<p class="crm-empty">Не получилось связаться с процессом. Проверьте, что он включён в n8n.</p>' +
          '<div class="crm-gate"><button type="button" class="crm-btn" id="crm-reload">Повторить</button></div>';
      });
  }

  // Слушаем корень: карточки перерисовываются целиком, поэтому вешать
  // обработчики на каждую кнопку пришлось бы после каждой перерисовки.
  root.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    if (b.id === 'crm-reload') { load(null); return; }
    if (b.id === 'crm-filter') { onlyHuman = !onlyHuman; if (lastData) render(lastData); return; }
    if (b.id === 'crm-unlock') {
      var f = document.getElementById('crm-key');
      if (f && f.value.trim()) { setKey(f.value.trim()); load(null); }
      return;
    }
    if (b.dataset && b.dataset.status) load({ id: b.dataset.id, status: b.dataset.status });
  });
  root.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.id === 'crm-key') {
      e.preventDefault();
      var u = document.getElementById('crm-unlock');
      if (u) u.click();
    }
  });

  var opened = false;
  function sync() {
    if (location.hash !== '#crm') return;
    section.hidden = false;
    if (!opened) { opened = true; load(null); }
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  window.addEventListener('hashchange', sync);
  sync();
})();
