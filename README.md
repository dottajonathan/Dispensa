# Dispensa

PWA per la lista della spesa di casa, condivisa tra Sabri e Jonathan, salvata su Google Sheet tramite backend Apps Script.
URL backend e token si inseriscono al primo avvio e restano sul dispositivo: nessun segreto nel repo.

- `index.html`, `app.js`, `style.css`, `sw.js`, `manifest.webmanifest`: app
- `backend/Code.gs`: copia di riferimento del backend Apps Script

Stati di una voce: `da_comprare`, `comprato` (preso in negozio), `ordinato` (inserito nell'ordine Esselunga da Claude), `eliminato`.
