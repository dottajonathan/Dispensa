/**
 * Dispensa - backend Apps Script
 * Versione 1.0
 *
 * Lista della spesa condivisa (Sabri e Jonathan) salvata su Google Sheet.
 * Claude legge lo stesso foglio con il connettore Google Sheets.
 *
 * Tutte le chiamate arrivano in POST con Content-Type text/plain
 * (evita il preflight CORS, che Apps Script non gestisce).
 * Corpo: JSON {token, action, ...}
 *
 * Azioni:
 *   ping                      -> {ok, versione}
 *   bootstrap                 -> {ok, voci, suggerimenti}
 *   add     {voce}            -> {ok, voce}
 *   update  {voce}            -> {ok, voce}      (voce.id obbligatorio)
 *   delete  {id}              -> {ok, id}        (eliminazione logica: stato = eliminato)
 *
 * Stati: da_comprare | comprato (preso in negozio) | ordinato (messo nell'ordine Esselunga) | eliminato
 */

const VERSIONE = '1.0';
const SHEET_LISTA = 'Lista';
const COLONNE = ['id', 'voce', 'quantita', 'nota', 'autore', 'stato', 'creato_il', 'aggiornato_il'];
const STATI = ['da_comprare', 'comprato', 'ordinato', 'eliminato'];
const TZ = 'Europe/Rome';
const MAX_SUGGERIMENTI = 80;

/* ---------- Setup: eseguire UNA volta a mano dall'editor ---------- */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_LISTA);
  if (!sh) sh = ss.insertSheet(SHEET_LISTA);
  sh.getRange(1, 1, 1, COLONNE.length).setValues([COLONNE]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('G:H').setNumberFormat('@'); // date come testo ISO

  const bytes = Utilities.getUuid() + Utilities.getUuid();
  const token = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
  ).replace(/=+$/, '');
  PropertiesService.getScriptProperties().setProperty('TOKEN', token);
  Logger.log('TOKEN (copialo e conservalo): ' + token);
}

/* ---------- Entry point ---------- */

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return risposta({ ok: false, errore: 'JSON non valido' });
  }
  const tokenAtteso = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!tokenAtteso || req.token !== tokenAtteso) {
    return risposta({ ok: false, errore: 'Non autorizzato' });
  }
  try {
    switch (req.action) {
      case 'ping':      return risposta({ ok: true, versione: VERSIONE });
      case 'bootstrap': return risposta(bootstrap());
      case 'add':       return conLock(() => aggiungi(req.voce));
      case 'update':    return conLock(() => aggiorna(req.voce));
      case 'delete':    return conLock(() => elimina(req.id));
      default:          return risposta({ ok: false, errore: 'Azione sconosciuta: ' + req.action });
    }
  } catch (err) {
    return risposta({ ok: false, errore: String(err && err.message || err) });
  }
}

function doGet() {
  // Nessun dato esposto in GET: serve solo a verificare che il deploy risponda.
  return risposta({ ok: true, servizio: 'Dispensa', versione: VERSIONE });
}

/* ---------- Azioni ---------- */

function bootstrap() {
  const tutte = leggiTutte();
  const voci = tutte.filter(v => v.stato === 'da_comprare');
  return { ok: true, versione: VERSIONE, voci: voci, suggerimenti: suggerimenti(tutte) };
}

function aggiungi(v) {
  const voce = valida(v);
  // stessa voce già in lista: niente doppione, si aggiorna quella esistente
  const esistente = leggiTutte().find(x => x.stato === 'da_comprare' &&
    normalizza(x.voce) === normalizza(voce.voce));
  if (esistente) {
    if (voce.quantita) esistente.quantita = voce.quantita;
    if (voce.nota) esistente.nota = voce.nota;
    return aggiorna(esistente, true);
  }
  const ora = adesso();
  voce.id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  voce.stato = 'da_comprare';
  voce.creato_il = ora;
  voce.aggiornato_il = ora;
  const sh = foglio();
  sh.appendRow(COLONNE.map(c => voce[c] === undefined ? '' : voce[c]));
  return { ok: true, voce: voce };
}

function aggiorna(v, interno) {
  if (!v || !v.id) throw new Error('id mancante');
  const sh = foglio();
  const r = trovaRiga(sh, v.id);
  if (r < 0) throw new Error('Voce non trovata: ' + v.id);
  const attuale = rigaInOggetto(sh.getRange(r, 1, 1, COLONNE.length).getValues()[0]);
  const voce = Object.assign({}, attuale);
  ['voce', 'quantita', 'nota', 'autore', 'stato'].forEach(k => {
    if (v[k] !== undefined) voce[k] = String(v[k]).trim();
  });
  if (!voce.voce) throw new Error('Voce vuota');
  if (STATI.indexOf(voce.stato) < 0) throw new Error('Stato non valido: ' + voce.stato);
  voce.aggiornato_il = adesso();
  sh.getRange(r, 1, 1, COLONNE.length).setValues([COLONNE.map(c => voce[c] === undefined ? '' : voce[c])]);
  return interno === true ? { ok: true, voce: voce, unita: true } : { ok: true, voce: voce };
}

function elimina(id) {
  return aggiorna({ id: id, stato: 'eliminato' });
}

/* ---------- Suggerimenti: voci usate in passato, le più frequenti prima ---------- */

function suggerimenti(tutte) {
  const conta = {};
  tutte.forEach(v => {
    if (!v.voce) return;
    const k = normalizza(v.voce);
    if (!conta[k]) conta[k] = { voce: v.voce, n: 0 };
    conta[k].n++;
  });
  return Object.keys(conta).map(k => conta[k])
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_SUGGERIMENTI)
    .map(x => x.voce);
}

/* ---------- Utilità ---------- */

function valida(v) {
  if (!v || !String(v.voce || '').trim()) throw new Error('Voce vuota');
  return {
    voce: String(v.voce).trim().slice(0, 80),
    quantita: String(v.quantita || '').trim().slice(0, 30),
    nota: String(v.nota || '').trim().slice(0, 120),
    autore: String(v.autore || '').trim().slice(0, 30)
  };
}

function leggiTutte() {
  const sh = foglio();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, COLONNE.length).getValues().map(rigaInOggetto);
}

function rigaInOggetto(riga) {
  const o = {};
  COLONNE.forEach((c, i) => o[c] = riga[i] === null ? '' : String(riga[i]));
  return o;
}

function trovaRiga(sh, id) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return -1;
  const ids = sh.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

function normalizza(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

function foglio() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LISTA);
  if (!sh) throw new Error('Foglio "' + SHEET_LISTA + '" mancante: eseguire setup()');
  return sh;
}

function adesso() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss");
}

function conLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return risposta(fn()); } finally { lock.releaseLock(); }
}

function risposta(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
