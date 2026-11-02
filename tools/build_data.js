// 미원부동산 마포구 대시보드 - 데이터 갱신 스크립트
// 공공데이터포털(국토교통부 실거래) + 한국부동산원 R-ONE + OpenStreetMap 데이터를 받아
// index.html 옆의 data.js 파일 하나로 저장합니다. (update_data.bat 으로 실행)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE);

const KEYS = Object.fromEntries(
  fs
    .readFileSync(path.join(__dirname, 'api_keys.txt'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => l.split('=').map((s) => s.trim())),
);
const MOLIT_KEY = KEYS.MOLIT_API_KEY;
const REB_KEY = KEYS.REB_API_KEY;
const MONTHS = 24; // 최근 24개월 실거래
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DAY = 86400000;

const log = (...a) => console.log(new Date().toLocaleTimeString('ko-KR'), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, opts = {}, retries = 3) {
  let last;
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000), ...opts });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`${url.split('?')[0]} : ${last.message}`);
}

function cacheRead(name, maxAge) {
  const f = path.join(CACHE, name);
  if (!fs.existsSync(f) || Date.now() - fs.statSync(f).mtimeMs > maxAge) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}
const cacheWrite = (name, data) => fs.writeFileSync(path.join(CACHE, name), JSON.stringify(data));

function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------- 국토교통부 실거래 ----------------
const MOLIT = {
  trade: 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade',
  rent: 'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent',
};

function parseItems(xml) {
  const code = (xml.match(/<resultCode>([^<]*)<\/resultCode>/) || [])[1];
  if (!code) throw new Error(`MOLIT 응답 오류: ${xml.slice(0, 150)}`);
  if (code !== '000') throw new Error(`MOLIT ${code} ${(xml.match(/<resultMsg>([^<]*)/) || [])[1]}`);
  const total = Number((xml.match(/<totalCount>(\d+)/) || [])[1] || 0);
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const o = {};
    for (const f of m[1].matchAll(/<(\w+)>([^<]*)<\/\1>/g)) o[f[1]] = f[2].trim();
    return o;
  });
  return { total, items };
}

async function molitMonth(kind, ym, ageMonths) {
  const name = `molit_${kind}_${ym}.json`;
  // 신고기한(30일) 지난 3개월 이전 자료는 확정 → 계속 재사용
  const cached = cacheRead(name, ageMonths >= 3 ? Infinity : DAY / 4);
  if (cached) return cached;
  let items = [];
  for (let p = 1; p < 50; p += 1) {
    const xml = await get(`${MOLIT[kind]}?serviceKey=${MOLIT_KEY}&LAWD_CD=11440&DEAL_YMD=${ym}&numOfRows=1000&pageNo=${p}`);
    const r = parseItems(xml);
    items = items.concat(r.items);
    if (items.length >= r.total) break;
  }
  cacheWrite(name, items);
  return items;
}

// ---------------- 한국부동산원 R-ONE ----------------
const REB_TABLES = {
  saleMonthly: { id: 'A_2024_00045', cycle: 'MM', mapo: '530026', seoul: '500008', name: '아파트 매매가격지수(월간)' },
  jeonseMonthly: { id: 'A_2024_00050', cycle: 'MM', mapo: '530026', seoul: '500008', name: '아파트 전세가격지수(월간)' },
  wolseMonthly: { id: 'A_2024_00055', cycle: 'MM', mapo: '530026', seoul: '500008', name: '아파트 월세가격지수(월간)' },
  saleWeekly: { id: 'T244183132827305', cycle: 'WK', mapo: '50058', seoul: '50008', name: '아파트 매매가격지수(주간)' },
  jeonseWeekly: { id: 'T247713133046872', cycle: 'WK', mapo: '50058', seoul: '50008', name: '아파트 전세가격지수(주간)' },
  unsold: { id: 'T237973129847263', cycle: 'MM', mapo: '50039', seoul: '50018', name: '미분양주택현황(호)' },
  volume: { id: 'A_2024_00554', cycle: 'MM', mapo: '510016', seoul: '500002', itm: '100001', name: '아파트 매매거래량(호)' },
};

async function rebSeries(t, cls) {
  const rows = [];
  for (let p = 1; p <= 5; p += 1) {
    const j = JSON.parse(
      await get(`https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do?KEY=${REB_KEY}&Type=json&pIndex=${p}&pSize=1000&STATBL_ID=${t.id}&DTACYCLE_CD=${t.cycle}&CLS_ID=${cls}`),
    );
    const b = j.SttsApiTblData;
    if (!b) break;
    rows.push(...(b[1]?.row || []));
    if (rows.length >= Number(b[0].head[0].list_total_count)) break;
  }
  const keep = t.cycle === 'WK' ? 104 : 60;
  return rows
    .filter((r) => !t.itm || String(r.ITM_ID) === t.itm)
    .map((r) => ({ t: String(r.WRTTIME_IDTFR_ID), label: r.WRTTIME_DESC, v: Math.round(Number(r.DTA_VAL) * 100) / 100 }))
    .sort((a, b) => a.t.localeCompare(b.t))
    .slice(-keep);
}

// ---------------- OpenStreetMap ----------------
async function overpass(q) {
  const servers = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  // 공용 서버가 붐비면(502/504/429) 기다렸다가 다시 시도 (최대 약 6분)
  let last;
  const waits = [0, 10, 20, 40, 60, 90, 120];
  for (const [n, w] of waits.entries()) {
    if (w) {
      log(`    지도서버 혼잡 → ${w}초 후 재시도 (${n}/${waits.length - 1})`);
      await sleep(w * 1000);
    }
    for (const s of servers) {
      try {
        const txt = await get(s, { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' } }, 1);
        return JSON.parse(txt);
      } catch (e) {
        last = e;
      }
    }
  }
  throw last;
}

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/e[-\s]?편한세상/g, '이편한세상')
    .replace(/에스케이/g, 'sk')
    .replace(/아파트|apt|apartment/g, '')
    .replace(/[\s·.,\-_'"]/g, '')
    .replace(/(제?\d+동|[a-z]동)$/g, '')
    .trim();

async function aptIndex() {
  const c = cacheRead('osm_apt_index.json', 30 * DAY);
  if (c) return c;
  const j = await overpass(
    '[out:json][timeout:120];area["name"="마포구"]["admin_level"="6"]->.a;(way["landuse"="residential"]["name"](area.a);relation["landuse"="residential"]["name"](area.a);way["building"="apartments"]["name"](area.a););out center tags;',
  );
  const groups = new Map();
  for (const el of j.elements) {
    const c2 = el.center || el;
    const n = norm(el.tags.name);
    if (!c2.lat || n.length < 3 || /^\d+$/.test(n)) continue;
    const isLanduse = el.tags.landuse === 'residential';
    const g = groups.get(n) || { name: el.tags.name, norm: n, lat: 0, lon: 0, k: 0, land: false };
    if (isLanduse && !g.land) Object.assign(g, { lat: 0, lon: 0, k: 0, land: true });
    if (g.land && !isLanduse) continue;
    g.lat += c2.lat;
    g.lon += c2.lon;
    g.k += 1;
    groups.set(n, g);
  }
  const idx = [...groups.values()].map((g) => ({ name: g.name, norm: g.norm, lat: g.lat / g.k, lon: g.lon / g.k }));
  cacheWrite('osm_apt_index.json', idx);
  return idx;
}

async function pois() {
  const c = cacheRead('osm_pois.json', 14 * DAY);
  if (c) return c;
  const b = '(37.515,126.835,37.605,126.99)';
  // 한 번에 받으면 서버 시간초과 → 종류별로 나눠서 받음
  const parts = [
    `node["railway"="station"]${b};node["public_transport"="station"]${b};`,
    `node["highway"="bus_stop"]${b};`,
    `nwr["amenity"="school"]${b};nwr["shop"~"^(supermarket|department_store|mall)$"]${b};`,
    `node["amenity"="cafe"]${b};`,
    `nwr["amenity"~"^(townhall|police|post_office|fire_station|library|hospital)$"]${b};nwr["office"="government"]${b};nwr["leisure"="park"]["name"]${b};`,
  ];
  const elements = [];
  for (const [i, p] of parts.entries()) {
    // 부분별로 캐시해 두어 중간에 실패해도 다음 실행 때 이어서 받음
    let els = cacheRead(`osm_pois_part${i}.json`, 14 * DAY);
    if (!els) {
      els = (await overpass(`[out:json][timeout:120];(${p});out center tags;`)).elements;
      cacheWrite(`osm_pois_part${i}.json`, els);
    }
    elements.push(...els);
    log(`    주변시설 ${i + 1}/${parts.length} (${els.length}개)`);
  }
  const out = [];
  const seen = new Set();
  for (const el of elements) {
    const t = el.tags || {};
    const c2 = el.center || el;
    if (!c2.lat) continue;
    const name = t.name || '';
    let cat = null;
    if (t.railway === 'station' || t.public_transport === 'station') cat = 'station';
    else if (t.highway === 'bus_stop') cat = 'bus';
    else if (t.amenity === 'school') cat = /초등학교/.test(name) ? 'elementary' : /중학교/.test(name) ? 'middle' : /고등학교/.test(name) ? 'high' : null;
    else if (t.shop === 'supermarket') cat = /이마트|홈플러스|롯데마트|코스트코|트레이더스|하나로/.test(name) ? 'mart' : 'super';
    else if (t.shop === 'department_store' || t.shop === 'mall') cat = 'department';
    else if (t.amenity === 'cafe') cat = 'cafe';
    else if (t.amenity === 'hospital') cat = 'hospital';
    else if (t.leisure === 'park') cat = 'park';
    else cat = 'government';
    if (!cat || (!name && cat !== 'cafe' && cat !== 'bus')) continue;
    const key = `${cat}|${name}|${c2.lat.toFixed(3)}|${c2.lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([cat, name, Math.round(c2.lat * 1e5) / 1e5, Math.round(c2.lon * 1e5) / 1e5]);
  }
  cacheWrite('osm_pois.json', out);
  return out;
}

// 구 경계: 행정경계 relation 의 바깥 선(way)들을 이어 붙여 폴리곤으로 만듦
async function boundary() {
  const c = cacheRead('mapo_boundary.json', 365 * DAY);
  if (c) return c;
  const j = await overpass('[out:json][timeout:60];relation["name"="마포구"]["admin_level"="6"]["boundary"="administrative"];out geom;');
  const rel = j.elements[0];
  const segs = rel.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry.map((p) => [p.lat, p.lon]));
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let grew = true;
    const same = (a, b2) => Math.abs(a[0] - b2[0]) < 1e-7 && Math.abs(a[1] - b2[1]) < 1e-7;
    while (grew) {
      grew = false;
      const start = ring[0];
      const end = ring[ring.length - 1];
      for (let i = 0; i < segs.length; i += 1) {
        const s = segs[i];
        const sEnd = s[s.length - 1];
        if (same(s[0], end)) ring = ring.concat(s.slice(1));
        else if (same(sEnd, end)) ring = ring.concat(s.slice(0, -1).reverse());
        else if (same(sEnd, start)) ring = s.slice(0, -1).concat(ring);
        else if (same(s[0], start)) ring = s.slice(1).reverse().concat(ring);
        else continue;
        segs.splice(i, 1);
        grew = true;
        break;
      }
    }
    rings.push(ring.map(([a, b2]) => [Math.round(a * 1e5) / 1e5, Math.round(b2 * 1e5) / 1e5]));
  }
  cacheWrite('mapo_boundary.json', rings);
  return rings;
}

// 법정동 대략 중심 (지도 이동용)
const DONG_CENTERS = {
  아현동: [37.5506, 126.9525], 공덕동: [37.5455, 126.951], 신공덕동: [37.544, 126.9555], 도화동: [37.5395, 126.949],
  용강동: [37.539, 126.9425], 토정동: [37.537, 126.939], 마포동: [37.5355, 126.9455], 대흥동: [37.55, 126.942],
  염리동: [37.551, 126.947], 노고산동: [37.5545, 126.9365], 신수동: [37.5475, 126.9355], 현석동: [37.544, 126.9355],
  구수동: [37.5455, 126.9325], 창전동: [37.549, 126.93], 상수동: [37.5475, 126.9225], 하중동: [37.545, 126.93],
  신정동: [37.544, 126.926], 당인동: [37.5445, 126.9175], 서교동: [37.553, 126.9195], 동교동: [37.559, 126.9255],
  합정동: [37.549, 126.908], 망원동: [37.556, 126.902], 연남동: [37.564, 126.923], 성산동: [37.566, 126.907],
  중동: [37.569, 126.913], 상암동: [37.577, 126.89],
};

function lcs(a, b) {
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}

function matchApt(index, aptNm, dc) {
  const n = norm(aptNm);
  let best = null;
  for (const e of index) {
    let s = 0;
    if (e.norm === n) s = 100;
    else if (n.length >= 3 && e.norm.includes(n)) s = 70 + (n.length / e.norm.length) * 20;
    else if (e.norm.length >= 4 && n.includes(e.norm)) s = 60 + (e.norm.length / n.length) * 20;
    else {
      // 표기 차이(레미안/래미안, 동네 이름 추가 등) → 공통 글자열이 충분히 길면 같은 동 근처일 때만 인정
      const l = lcs(n, e.norm);
      if (l >= 4 && l / Math.min(n.length, e.norm.length) >= 0.5) s = 30 + l;
    }
    if (!s) continue;
    if (dc) {
      const d = distM(dc[0], dc[1], e.lat, e.lon);
      if (d > (s < 60 ? 1300 : 2500)) continue;
      if (d < 1200) s += 10;
    }
    if (!best || s > best.s) best = { ...e, s };
  }
  return best;
}

// ---------------- 실행 ----------------
(async () => {
  log('데이터 갱신 시작');
  const now = new Date();
  const months = [];
  for (let i = 0; i < MONTHS; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ ym: `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`, age: i });
  }

  // 1) 실거래
  const complexes = [];
  const cIndex = new Map();
  const deals = [];
  const errors = [];
  for (const { ym, age } of months) {
    for (const kind of ['trade', 'rent']) {
      let items = [];
      try {
        items = await molitMonth(kind, ym, age);
      } catch (e) {
        errors.push(`${ym} ${kind === 'trade' ? '매매' : '전월세'}: ${e.message}`);
        log('  실패', ym, kind, e.message);
        continue;
      }
      for (const it of items) {
        if (kind === 'trade' && it.cdealType === 'O') continue; // 해제된 거래 제외
        const key = `${it.umdNm}|${it.aptNm}|${it.jibun}`;
        let ci = cIndex.get(key);
        if (ci === undefined) {
          ci = complexes.length;
          cIndex.set(key, ci);
          complexes.push({ aptNm: it.aptNm, dong: it.umdNm, jibun: it.jibun, buildYear: Number(it.buildYear) || 0 });
        }
        const n = (v) => Number(String(v || '0').replace(/,/g, '')) || 0;
        const date = `${it.dealYear}${String(it.dealMonth).padStart(2, '0')}${String(it.dealDay).padStart(2, '0')}`;
        if (kind === 'trade') {
          deals.push([0, ci, n(it.excluUseAr), n(it.dealAmount), 0, n(it.floor), date, 0]);
        } else {
          const rent = n(it.monthlyRent);
          deals.push([rent > 0 ? 2 : 1, ci, n(it.excluUseAr), n(it.deposit), rent, n(it.floor), date, it.contractType === '갱신' ? 1 : 0]);
        }
      }
    }
    log(`  실거래 ${ym} 완료 (누적 ${deals.length}건)`);
  }

  // 2) R-ONE 통계
  const market = {};
  for (const [k, t] of Object.entries(REB_TABLES)) {
    try {
      market[k] = { name: t.name, mapo: await rebSeries(t, t.mapo), seoul: await rebSeries(t, t.seoul) };
      log(`  R-ONE ${t.name} 완료`);
    } catch (e) {
      const old = cacheRead(`reb_${k}.json`, Infinity);
      market[k] = old || { name: t.name, mapo: [], seoul: [] };
      errors.push(`R-ONE ${t.name}: ${e.message}`);
    }
    cacheWrite(`reb_${k}.json`, market[k]);
  }

  // 3) 지도 / 주변시설
  let idx = [];
  let poiList = [];
  let rings = [];
  try {
    idx = await aptIndex();
    log(`  아파트 위치 목록 ${idx.length}개`);
  } catch (e) {
    errors.push(`아파트 위치: ${e.message}`);
  }
  try {
    poiList = await pois();
    log(`  주변시설 ${poiList.length}개`);
  } catch (e) {
    poiList = cacheRead('osm_pois.json', Infinity) || []; // 실패 시 예전 자료라도 사용
    errors.push(`주변시설: ${e.message}`);
  }
  try {
    rings = await boundary();
    log('  마포구 경계 완료');
  } catch (e) {
    errors.push(`구 경계: ${e.message}`);
  }

  // 4) 단지 좌표 (OSM 이름 매칭 → Nominatim 검색 → 실패 시 법정동 중심 근처, 근사 표시)
  const geoFile = path.join(CACHE, 'geocache.json');
  let geocache = {};
  try {
    geocache = JSON.parse(fs.readFileSync(geoFile, 'utf8'));
  } catch {}
  let found = 0;
  let lookups = 0;
  for (const c of complexes) {
    const dc = DONG_CENTERS[c.dong];
    let m = matchApt(idx, c.aptNm, dc);
    const gk = `${c.dong}|${c.aptNm}`;
    if (!m && geocache[gk] === undefined && lookups < 250) {
      lookups += 1;
      geocache[gk] = null;
      try {
        const q = `${c.aptNm.replace(/\(.*?\)/g, '')}`;
        const r = JSON.parse(
          await get(`https://nominatim.openstreetmap.org/search?format=json&limit=3&countrycodes=kr&viewbox=126.85,37.60,126.97,37.53&bounded=1&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'MiwonRealtyDashboard/1.0 (local broker dashboard)' } }, 1),
        );
        const hit = r.find((x) => !['suburb', 'quarter', 'city_district', 'borough', 'road'].includes(x.addresstype) && (!dc || distM(dc[0], dc[1], +x.lat, +x.lon) < 1800));
        if (hit) geocache[gk] = { lat: +hit.lat, lon: +hit.lon };
      } catch (e) {
        delete geocache[gk];
      }
      await sleep(1200);
      if (lookups % 25 === 0) log(`    위치 검색 ${lookups}건 진행`);
    }
    if (!m && geocache[gk]) m = geocache[gk];
    if (m) {
      c.lat = Math.round(m.lat * 1e5) / 1e5;
      c.lon = Math.round(m.lon * 1e5) / 1e5;
      found += 1;
    } else {
      const base = dc || [37.5622, 126.9087];
      let h = 0;
      for (const ch of c.aptNm + c.jibun) h = (h * 31 + ch.charCodeAt(0)) % 10007;
      c.lat = Math.round((base[0] + ((h % 100) - 50) * 0.00005) * 1e5) / 1e5;
      c.lon = Math.round((base[1] + ((Math.floor(h / 100) % 100) - 50) * 0.00007) * 1e5) / 1e5;
      c.approx = 1;
    }
  }
  fs.writeFileSync(geoFile, JSON.stringify(geocache));
  log(`  단지 ${complexes.length}개 중 ${found}개 정확한 위치 확인`);

  const data = {
    generatedAt: new Date().toISOString(),
    range: { from: `${months[months.length - 1].ym.slice(0, 4)}-${months[months.length - 1].ym.slice(4)}-01` },
    complexes: complexes.map((c) => [c.aptNm, c.dong, c.jibun, c.buildYear, c.lat, c.lon, c.approx || 0]),
    deals,
    market,
    pois: poiList,
    boundary: rings,
    dongCenters: DONG_CENTERS,
    errors,
  };
  fs.writeFileSync(path.join(ROOT, 'data.js'), `window.DASH_DATA = ${JSON.stringify(data)};\n`, 'utf8');
  const mb = (fs.statSync(path.join(ROOT, 'data.js')).size / 1048576).toFixed(1);
  log(`완료! data.js 저장 (${mb}MB, 거래 ${deals.length}건)`);
  if (errors.length) log('일부 오류:', errors.join(' / '));
})().catch((e) => {
  console.error('데이터 갱신 실패:', e);
  process.exitCode = 1;
});
