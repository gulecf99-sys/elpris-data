// Henter ladestandere og priser fra operatørernes AFIR-data (Spirii, DATEX II) og skriver dem som små
// geografiske fliser (0,25° × 0,5°), som Elpris-appen læser. Køres af GitHub Actions hver anden time.
// Brug: node scripts/ladestandere.mjs <ud-mappe>
import fs from 'node:fs';
import path from 'node:path';
const OUT = process.argv[2] || 'out';
export const SPIRII = 'https://api.spirii.com/v2/afir/energy-infrastructure-tables?countryIsos=DK&cpoId=';
export const CPOS = [[1, 'Spirii'], [4, 'Aura'], [7, 'PowerGo'], [8, 'Looad'], [10, 'DCC Energi'], [16, 'Shell Recharge'], [20, 'Verdo'], [25, 'TotalEnergies'], [36, 'DEAS'], [37, 'EDF'], [44, 'CL Electric'], [47, 'EBO Consult'], [50, 'DitoBus'], [56, 'By & Havn'], [57, 'Region H'], [59, 'Ø/Strøm'], [83, 'EV-EL'], [84, 'nef Strøm'], [90, 'EVDK']];
const txt = v => (v && v.values && v.values[0] && v.values[0].value) || '';
export function rateOf(rates) {
  // Én tarif: fast pris, tidsvinduer (fx 16–20) og/eller dynamiske 15-min.-priser for i dag og i morgen.
  const out = { flat: null, tou: [], dyn: {}, start: 0, perMin: null };
  for (const r of rates || []) for (const e of r.energyPrice || []) {
    const rate = e.taxRate > 1 ? e.taxRate / 100 : (e.taxRate || 0.25);
    const v = Math.round((e.taxIncluded === false ? e.value * (1 + rate) : e.value) * 100) / 100;
    const type = e.priceType && e.priceType.value, per = e.overallPeriod;
    if (type === 'flatRate') { out.start = Math.max(out.start, v); continue; }
    if (type === 'pricePerMinute') { if (v > 0) out.perMin = v; continue; }
    if (type !== 'pricePerKWh') continue;
    const wins = per && per.validPeriod ? per.validPeriod.flatMap(x => x.recurringTimePeriodOfDay || []) : [];
    if (per && per.overallEndTime && wins.length) { const d = String(per.overallStartTime).slice(0, 10); wins.forEach(w => { out.dyn[d + 'T' + w.startTimeOfPeriod] = v; }); }
    else if (wins.length) wins.forEach(w => out.tou.push([w.startTimeOfPeriod, w.endTimeOfPeriod, v]));
    else out.flat = v;
  }
  // Dynamiske priser som tæt række pr. kvarter fra første tidspunkt (huller = null), højst 3 døgn.
  const keys = Object.keys(out.dyn).sort(); let dyn = null;
  if (keys.length) { const b = keys[0], n = Math.min(288, (Date.parse(keys[keys.length - 1] + 'Z') - Date.parse(b + 'Z')) / 900000 + 1), vals = [];
    for (let i = 0; i < n; i++) { const k = new Date(Date.parse(b + 'Z') + i * 900000).toISOString().slice(0, 16); vals.push(out.dyn[k] ?? null); } dyn = [b, vals]; }
  return { flat: out.flat, tou: out.tou, dyn, start: out.start || 0, perMin: out.perMin };
}
export function parseSites(j, opName) {
  const pub = (j.payload || (j.messageContainer && j.messageContainer.payload[0]) || {}).aegiEnergyInfrastructureTablePublication;
  const sites = ((pub && pub.energyInfrastructureTable) || []).flatMap(t => t.energyInfrastructureSite || []);
  const out = [];
  for (const s of sites) {
    const loc = s.locationReference && s.locationReference.locAreaLocation, c = loc && loc.coordinatesForDisplay;
    if (!c || !c.latitude) continue;
    const name = txt(s.name);
    if (/privat|kun for beboere|employee only|bag lukket hegn|ikke offentlig/i.test(name)) continue;
    const adr = loc.locLocationExtensionG && loc.locLocationExtensionG.FacilityLocation && loc.locLocationExtensionG.FacilityLocation.address;
    let kwAC = 0, kwDC = 0, nAC = 0, nDC = 0, rAC = null, rDC = null;
    for (const st of s.energyInfrastructureStation || []) for (const rp of st.refillPoint || []) {
      const cp = rp.aegiElectricChargingPoint; if (!cp) continue;
      const dc = cp.currentType && cp.currentType.value === 'dc';
      const kw = Math.max(0, ...(cp.connector || []).map(x => (x.maxPowerAtSocket || 0) / 1000));
      const rates = (cp.electricEnergy || []).flatMap(e => e.energyRate || []);
      if (dc) { nDC++; kwDC = Math.max(kwDC, kw); if (!rDC && rates.length) rDC = rateOf(rates); }
      else { nAC++; kwAC = Math.max(kwAC, kw); if (!rAC && rates.length) rAC = rateOf(rates); }
    }
    if (!nAC && !nDC) continue;
    out.push({ id: s.idG, n: name, op: txt(s.operator && s.operator.afacAnOrganisation && s.operator.afacAnOrganisation.name) || opName,
      a: adr ? (adr.addressLine || []).map(l => txt(l.text)).join(', ') : '', z: adr ? adr.postcode || '' : '', c: adr ? txt(adr.city) : '',
      lat: Math.round(c.latitude * 1e5) / 1e5, lon: Math.round(c.longitude * 1e5) / 1e5, ac: nAC ? [nAC, Math.round(kwAC), rAC] : null, dc: nDC ? [nDC, Math.round(kwDC), rDC] : null });
  }
  return out;
}

export const tileKey = (lat, lon) => Math.floor(lat * 4) + '_' + Math.floor(lon * 2);

// Forrige kørsel (data-grenen tjekket ud i ./prev af workflowet), bruges som reserve.
let PREV = [], PREV_IDX = {};
function loadPrev(prevDir) {
  try { PREV_IDX = JSON.parse(fs.readFileSync(path.join(prevDir, 'lade', 'idx.json'), 'utf8')); } catch { return; }
  for (const k of PREV_IDX.tiles || []) { try { PREV.push(...JSON.parse(fs.readFileSync(path.join(prevDir, 'lade', k + '.json'), 'utf8'))); } catch {} }
}
export async function main() {
  loadPrev(process.argv[3] || 'prev');
  const dir = path.join(OUT, 'lade'); fs.mkdirSync(dir, { recursive: true });
  const tiles = {}, ops = {}; let total = 0, ok = 0;
  for (const [id, name] of CPOS) {
    try {
      const r = await fetch(SPIRII + id, { headers: { 'accept-encoding': 'gzip', 'user-agent': 'Elpris-data (github.com)' }, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const sites = parseSites(await r.json(), name);
      for (const s of sites) { s.cpo = id; (tiles[tileKey(s.lat, s.lon)] ||= []).push(s); }
      ops[id] = { name, n: sites.length, at: Date.now() }; total += sites.length; ok++;
      console.log(name.padEnd(16), String(sites.length).padStart(5), 'ladesteder');
    } catch (e) {
      // Behold forrige kørsels ladere for denne operatør, så de ikke forsvinder ved en midlertidig fejl.
      const old = PREV.filter(s => s.cpo === id); for (const s of old) (tiles[tileKey(s.lat, s.lon)] ||= []).push(s);
      ops[id] = Object.assign({}, PREV_IDX.ops?.[id] || {}, { name, n: old.length, err: String(e.message || e), errAt: Date.now() }); total += old.length;
      console.log(name.padEnd(16), 'FEJL', String(e.message || e), old.length ? '– beholder ' + old.length + ' fra sidst' : '');
    }
  }
  if (ok < Math.ceil(CPOS.length / 2)) { console.error('For få operatører hentet (' + ok + '/' + CPOS.length + ') – gemmer ikke.'); process.exit(1); }
  for (const [k, list] of Object.entries(tiles)) fs.writeFileSync(path.join(dir, k + '.json'), JSON.stringify(list));
  fs.writeFileSync(path.join(dir, 'idx.json'), JSON.stringify({ at: Date.now(), total, ops, tiles: Object.keys(tiles).sort() }));
  console.log('I alt', total, 'ladesteder i', Object.keys(tiles).length, 'fliser');
}
if (import.meta.url === 'file://' + path.resolve(process.argv[1])) main();
