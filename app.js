/* Dispensa - lista della spesa condivisa (PWA)
 * Backend: Apps Script (backend/Code.gs) su Google Sheet.
 * URL, token e nome restano solo su questo dispositivo (localStorage).
 */
'use strict';

const VERSIONE_APP = '1.0.0';
const K = { cfg: 'disp_cfg', items: 'disp_items', sugg: 'disp_sugg', queue: 'disp_queue' };
const UNDO_MS = 4000;

const $ = s => document.querySelector(s);
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

let cfg = load(K.cfg, null);          // {url, token, nome}
let items = load(K.items, []);        // voci da_comprare (anche locali "tmp_")
let sugg = load(K.sugg, []);          // suggerimenti dal backend
let queue = load(K.queue, []);        // operazioni non ancora inviate
let flushing = false;
let pendingDone = {};                 // id -> timer (spunte in attesa di conferma)

/* ---------- Backend ---------- */

async function api(action, extra) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ token: cfg.token, action }, extra || {})),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (!j.ok) { const e = new Error(j.errore || 'Errore'); e.server = true; throw e; }
  return j;
}

async function refresh(manual) {
  if (!cfg) return;
  const btn = $('#btn-refresh');
  if (manual) btn.classList.add('spin');
  try {
    await flush();
    if (queue.length) return; // ancora offline: teniamo lo stato locale
    const j = await api('bootstrap');
    const locali = items.filter(i => String(i.id).startsWith('tmp_'));
    items = j.voci.concat(locali);
    sugg = j.suggerimenti || [];
    save(K.items, items); save(K.sugg, sugg);
    setSync('ok');
    render();
  } catch (e) {
    setSync(e.server ? 'ok' : 'offline');
    if (e.server) toast(e.message);
    else if (manual) toast('Nessuna connessione: riprovo più tardi');
  } finally {
    btn.classList.remove('spin');
  }
}

/* Coda: un'operazione alla volta, nell'ordine in cui sono state fatte */
async function flush() {
  if (flushing || !cfg) return;
  flushing = true;
  try {
    while (queue.length) {
      setSync('pending');
      const op = queue[0];
      let j;
      try {
        j = await api(op.action, op.payload);
      } catch (e) {
        if (e.server) { // errore applicativo: si scarta l'operazione, non si blocca la coda
          toast('Non salvato: ' + e.message);
          queue.shift(); save(K.queue, queue);
          continue;
        }
        setSync('offline');
        return;
      }
      queue.shift(); save(K.queue, queue);
      if (op.action === 'add' && op.tmp) sostituisciTmp(op.tmp, j.voce);
    }
    setSync('ok');
  } finally {
    flushing = false;
  }
}

function sostituisciTmp(tmp, voce) {
  // l'id provvisorio diventa quello vero, anche nelle operazioni ancora in coda
  const idx = items.findIndex(i => i.id === tmp);
  const dup = items.findIndex(i => i.id === voce.id);
  if (idx >= 0 && dup >= 0 && dup !== idx) items.splice(idx, 1);
  else if (idx >= 0) items[idx] = voce;
  queue.forEach(op => { if (op.payload && op.payload.voce && op.payload.voce.id === tmp) op.payload.voce.id = voce.id; if (op.payload && op.payload.id === tmp) op.payload.id = voce.id; });
  if (pendingDone[tmp]) { pendingDone[voce.id] = pendingDone[tmp]; delete pendingDone[tmp]; }
  save(K.items, items); save(K.queue, queue);
  render();
}

function enqueue(action, payload, tmp) {
  queue.push({ action, payload, tmp });
  save(K.queue, queue);
  flush();
}

/* ---------- Azioni utente ---------- */

function aggiungi(testo) {
  testo = String(testo || '').trim();
  if (!testo) return;
  const norm = normalizza(testo);
  const gia = items.find(i => normalizza(i.voce) === norm);
  if (gia) { toast('"' + gia.voce + '" è già in lista'); evidenzia(gia.id); return; }
  const tmp = 'tmp_' + Date.now().toString(36);
  const voce = { id: tmp, voce: testo, quantita: '', nota: '', autore: cfg.nome, stato: 'da_comprare' };
  items.unshift(voce);
  save(K.items, items);
  render();
  enqueue('add', { voce: { voce: testo, autore: cfg.nome } }, tmp);
}

function spunta(id) {
  const el = document.querySelector('[data-id="' + id + '"]');
  if (pendingDone[id]) { // seconda tocco = annulla
    clearTimeout(pendingDone[id]); delete pendingDone[id];
    if (el) el.classList.remove('done');
    hideToast();
    return;
  }
  if (el) el.classList.add('done');
  const v = items.find(i => i.id === id);
  toast('Preso: ' + (v ? v.voce : ''), 'Annulla', () => spunta(id));
  pendingDone[id] = setTimeout(() => {
    delete pendingDone[id];
    if (el) el.classList.add('leaving');
    setTimeout(() => {
      items = items.filter(i => i.id !== id);
      save(K.items, items); render();
      enqueue('update', { voce: { id, stato: 'comprato' } });
    }, 250);
  }, UNDO_MS);
}

function elimina(id) {
  const v = items.find(i => i.id === id);
  items = items.filter(i => i.id !== id);
  save(K.items, items); render();
  enqueue('delete', { id });
  if (v) toast('Tolto: ' + v.voce);
}

function modifica(id, quantita, nota) {
  const v = items.find(i => i.id === id);
  if (!v) return;
  v.quantita = quantita; v.nota = nota;
  save(K.items, items); render();
  enqueue('update', { voce: { id, quantita, nota } });
}

/* ---------- Interfaccia ---------- */

function render() {
  const ul = $('#list');
  ul.innerHTML = '';
  $('#empty').classList.toggle('hidden', items.length > 0);
  $('#sub').textContent = items.length ? (items.length === 1 ? '1 cosa da comprare' : items.length + ' cose da comprare') : 'Cosa manca in casa';
  items.forEach(v => {
    const li = document.createElement('li');
    li.className = 'item' + (String(v.id).startsWith('tmp_') ? ' local' : '') + (pendingDone[v.id] ? ' done' : '');
    li.dataset.id = v.id;
    const iniz = (v.autore || '?').trim().charAt(0).toUpperCase();
    const cls = iniz === 'S' ? 'S' : iniz === 'J' ? 'J' : 'X';
    li.innerHTML =
      '<button class="check" aria-label="Segna come preso"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
      '<div class="txt"><b></b><div class="meta"></div></div>' +
      '<span class="who ' + cls + '" title=""></span>' +
      '<button class="more" aria-label="Modifica"><svg viewBox="0 0 24 24"><circle cx="12" cy="5.5" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="18.5" r="1.8" fill="currentColor"/></svg></button>';
    li.querySelector('b').textContent = v.voce;
    const meta = li.querySelector('.meta');
    if (v.quantita) { const q = document.createElement('span'); q.className = 'qty'; q.textContent = v.quantita; meta.appendChild(q); }
    if (v.nota) { const n = document.createElement('span'); n.textContent = v.nota; meta.appendChild(n); }
    if (!v.quantita && !v.nota) meta.remove();
    const who = li.querySelector('.who'); who.textContent = iniz; who.title = 'Aggiunto da ' + (v.autore || '?');
    li.querySelector('.check').onclick = () => spunta(v.id);
    li.querySelector('.more').onclick = () => apriModifica(v.id);
    li.querySelector('.txt').onclick = () => apriModifica(v.id);
    ul.appendChild(li);
  });
  renderSugg();
}

function renderSugg() {
  const box = $('#sugg');
  const q = normalizza($('#inp').value);
  const inLista = new Set(items.map(i => normalizza(i.voce)));
  let lista = sugg.filter(s => !inLista.has(normalizza(s)));
  if (q) lista = lista.filter(s => normalizza(s).includes(q)).sort((a, b) => normalizza(a).indexOf(q) - normalizza(b).indexOf(q));
  lista = lista.slice(0, 12);
  box.innerHTML = '';
  box.classList.toggle('hidden', lista.length === 0);
  lista.forEach(s => {
    const c = document.createElement('button');
    c.type = 'button'; c.className = 'chip'; c.textContent = s;
    c.onclick = () => { aggiungi(s); $('#inp').value = ''; renderSugg(); };
    box.appendChild(c);
  });
}

function evidenzia(id) {
  const el = document.querySelector('[data-id="' + id + '"]');
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.animate([{ background: '#FFF1D9' }, { background: '#FFFFFF' }], { duration: 1200 });
}

function apriSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.remove('hidden');
}
function chiudiSheet() { $('#sheet').classList.add('hidden'); }
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet' && cfg) chiudiSheet(); });

function apriModifica(id) {
  const v = items.find(i => i.id === id);
  if (!v) return;
  apriSheet(
    '<h2></h2>' +
    '<label class="field"><span>Quantità</span><input id="m-q" placeholder="es. 2, 1 kg, una confezione grande" maxlength="30"></label>' +
    '<label class="field"><span>Nota</span><input id="m-n" placeholder="es. quello senza lattosio" maxlength="120"></label>' +
    '<div class="btns"><button class="btn danger" id="m-del">Togli</button><button class="btn primary" id="m-ok">Salva</button></div>'
  );
  $('#sheet-body h2').textContent = v.voce;
  $('#m-q').value = v.quantita || '';
  $('#m-n').value = v.nota || '';
  $('#m-ok').onclick = () => { modifica(id, $('#m-q').value.trim(), $('#m-n').value.trim()); chiudiSheet(); };
  $('#m-del').onclick = () => { elimina(id); chiudiSheet(); };
}

function apriImpostazioni(primoAvvio) {
  const c = cfg || { url: '', token: '', nome: '' };
  apriSheet(
    '<h2>' + (primoAvvio ? 'Configuriamo Dispensa' : 'Impostazioni') + '</h2>' +
    '<label class="field"><span>Chi sei?</span></label>' +
    '<div class="seg" id="s-nome"><button type="button" data-n="Sabri">Sabri</button><button type="button" data-n="Jonathan">Jonathan</button></div>' +
    '<div style="height:14px"></div>' +
    '<label class="field"><span>URL del backend</span><input id="s-url" placeholder="https://script.google.com/macros/s/…/exec" inputmode="url"></label>' +
    '<label class="field"><span>Token</span><input id="s-tok" type="password" placeholder="Incolla il token"></label>' +
    '<p class="hint">URL e token restano solo su questo telefono.</p>' +
    '<div class="err" id="s-err"></div>' +
    '<div class="btns">' + (primoAvvio ? '' : '<button class="btn" id="s-x">Chiudi</button>') + '<button class="btn primary" id="s-ok">Salva e prova</button></div>' +
    '<p class="hint" style="margin-top:14px;text-align:center">Dispensa ' + VERSIONE_APP + '</p>'
  );
  let nome = c.nome;
  const seg = $('#s-nome');
  const segna = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.n === nome));
  seg.querySelectorAll('button').forEach(b => b.onclick = () => { nome = b.dataset.n; segna(); });
  segna();
  $('#s-url').value = c.url; $('#s-tok').value = c.token;
  if ($('#s-x')) $('#s-x').onclick = chiudiSheet;
  $('#s-ok').onclick = async () => {
    const url = $('#s-url').value.trim(), token = $('#s-tok').value.trim();
    const err = $('#s-err');
    if (!nome) { err.textContent = 'Scegli chi sei'; return; }
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) { err.textContent = "L'URL deve iniziare con https://script.google.com e finire con /exec"; return; }
    if (!token) { err.textContent = 'Incolla il token'; return; }
    err.textContent = 'Provo la connessione…';
    const vecchio = cfg;
    cfg = { url, token, nome };
    try {
      await api('ping');
      save(K.cfg, cfg);
      chiudiSheet();
      toast('Collegato');
      refresh();
    } catch (e) {
      cfg = vecchio;
      err.textContent = e.server ? ('Il backend risponde: ' + e.message) : 'Non riesco a raggiungere il backend: controlla URL e connessione';
    }
  };
}

let toastTimer;
function toast(msg, azione, fn) {
  const t = $('#toast');
  t.innerHTML = '';
  const s = document.createElement('span'); s.textContent = msg; t.appendChild(s);
  if (azione) { const b = document.createElement('button'); b.textContent = azione; b.onclick = () => { hideToast(); fn(); }; t.appendChild(b); }
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, azione ? UNDO_MS : 2500);
}
function hideToast() { $('#toast').classList.add('hidden'); }

function setSync(stato) {
  const s = $('#sync');
  s.className = 'sync' + (stato === 'pending' ? ' pending' : stato === 'offline' ? ' offline' : '');
  s.title = stato === 'offline' ? 'Offline: salvo sul telefono e invio appena possibile' : stato === 'pending' ? 'Invio in corso' : 'Sincronizzato';
}

function normalizza(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

/* ---------- Avvio ---------- */

$('#add').addEventListener('submit', e => {
  e.preventDefault();
  aggiungi($('#inp').value);
  $('#inp').value = '';
  renderSugg();
});
$('#inp').addEventListener('input', renderSugg);
$('#btn-refresh').onclick = () => refresh(true);
$('#btn-set').onclick = () => apriImpostazioni(false);
window.addEventListener('online', () => refresh());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 60000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

render();
if (!cfg) apriImpostazioni(true);
else { if (queue.length) setSync('pending'); refresh(); }
