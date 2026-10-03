// ==UserScript==
// @name         淘寶價格自動記錄
// @namespace    tb-price-recorder
// @version      1.0
// @description  打開淘寶／天貓商品頁時自動記錄價格，顯示歷史最低、走勢與目標價提醒
// @match        *://item.taobao.com/*
// @match        *://detail.tmall.com/*
// @match        *://chaoshi.detail.tmall.com/*
// @match        *://detail.tmall.hk/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORE = 'tbpr_items';
  const SEL_KEY = 'tbpr_sel_' + location.hostname;
  const itemId = new URLSearchParams(location.search).get('id');
  if (!itemId) return;

  // ---------- 工具 ----------
  const pad = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const fmt = n => (Math.round(n * 100) / 100).toLocaleString('zh-Hant', { maximumFractionDigits: 2 });
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const load = () => { try { return JSON.parse(GM_getValue(STORE, '{}')); } catch (e) { return {}; } };
  const save = o => GM_setValue(STORE, JSON.stringify(o));
  const num = t => { const m = (t || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };

  // ---------- 偵測價格 ----------
  // 淘寶改版時這些選擇器可能失效；失效時可用面板上的「選取價格位置」手動指定
  const KNOWN = [
    '[class*="highlightPrice"] [class*="priceText"]',
    '[class*="Price--priceText"]',
    '[class*="priceText"]',
    '#J_PromoPriceNum',
    '#J_StrPrice .tb-rmb-num',
    '.tm-promo-price .tm-price',
    '.tm-price',
    '.tb-rmb-num'
  ];

  function visible(el) { return el.getClientRects().length > 0; }

  function detectPrice() {
    const custom = GM_getValue(SEL_KEY, '');
    const list = custom ? [custom, ...KNOWN] : KNOWN;
    for (const s of list) {
      let els; try { els = document.querySelectorAll(s); } catch (e) { continue; }
      for (const el of els) {
        if (!visible(el)) continue;
        const v = num(el.textContent);
        if (v > 0 && v < 1e7) return v;
      }
    }
    return null;
  }

  function detectTitle() {
    const h = document.querySelector('[class*="mainTitle"], .tb-main-title, .tb-detail-hd h1');
    const t = (h && h.textContent.trim()) || document.title;
    return t.replace(/[-–]\s*(淘宝网|淘寶網|tmall\.com天猫|天猫Tmall\.com|天猫超市).*$/i, '').trim().slice(0, 80);
  }

  // ---------- 記錄 ----------
  function record(price) {
    const items = load();
    const it = items[itemId] || { points: [], target: null, created: Date.now() };
    it.name = detectTitle() || it.name || ('商品 ' + itemId);
    it.url = `${location.origin}${location.pathname}?id=${itemId}`;
    const d = today();
    const last = it.points[it.points.length - 1];
    if (last && last.d === d) last.p = price; // 同一天只保留最新一筆
    else it.points.push({ d, p: price });
    it.updated = Date.now();
    items[itemId] = it;
    save(items);
    return it;
  }

  function analyze(it) {
    const pts = [...(it.points || [])].sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
    if (!pts.length) return null;
    const ps = pts.map(p => p.p);
    const cur = ps[ps.length - 1], min = Math.min(...ps), max = Math.max(...ps);
    const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
    const minD = pts.find(p => p.p === min).d;
    let v;
    if (it.target && cur <= it.target) v = { k: 'hit', t: '已達目標價', s: `低於你設定的 ¥${fmt(it.target)}` };
    else if (pts.length === 1) v = { k: 'new', t: '第一筆紀錄', s: '之後每次打開都會自動記錄' };
    else if (cur <= min) v = { k: 'low', t: '歷史最低價', s: '有紀錄以來最便宜' };
    else if ((cur - min) / min <= 0.05) v = { k: 'low', t: '接近最低價', s: `只比最低貴 ¥${fmt(cur - min)}` };
    else if (cur > avg) v = { k: 'high', t: '比平均貴', s: `比最低貴 ¥${fmt(cur - min)}，可以再等等` };
    else v = { k: 'mid', t: '一般價位', s: `比最低貴 ¥${fmt(cur - min)}` };
    return { pts, cur, min, max, avg, minD, v };
  }

  function spark(a, target) {
    if (a.pts.length < 2) return '';
    const W = 268, H = 70, P = 6;
    const ts = a.pts.map(p => new Date(p.d + 'T00:00:00').getTime());
    const t0 = ts[0], t1 = ts[ts.length - 1] === t0 ? t0 + 1 : ts[ts.length - 1];
    let lo = Math.min(a.min, target || Infinity), hi = Math.max(a.max, target || 0);
    if (hi === lo) { hi += 1; lo -= 1; }
    const x = t => P + (t - t0) / (t1 - t0) * (W - 2 * P);
    const y = v => P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P);
    const line = a.pts.map((p, i) => `${x(ts[i]).toFixed(1)},${y(p.p).toFixed(1)}`).join(' ');
    let g = `<line x1="${P}" x2="${W - P}" y1="${y(a.min)}" y2="${y(a.min)}" class="minl"/>`;
    if (target) g += `<line x1="${P}" x2="${W - P}" y1="${y(target)}" y2="${y(target)}" class="tgl"/>`;
    g += `<polyline points="${line}" class="pl"/>`;
    const lx = x(ts[ts.length - 1]), ly = y(a.cur);
    g += `<circle cx="${lx}" cy="${ly}" r="4" class="cur"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" aria-label="價格走勢">${g}</svg>`;
  }

  // ---------- 面板 ----------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  const STYLE = `
  :host{all:initial}
  *{box-sizing:border-box}
  .card{--bg:#fff;--ink:#1C2541;--mut:#6B7489;--line:#DDE1E8;--price:#D7263D;--good:#13795B;--tg:#2F5BD3;--stk:#FFD93D;--soft:#EEF1F6;
    font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;font-size:13px;line-height:1.5;color:var(--ink);
    width:300px;max-height:80vh;overflow:auto;background:var(--bg);border:1.5px solid var(--line);border-radius:14px;box-shadow:0 8px 28px rgba(15,20,35,.18);padding:14px}
  @media (prefers-color-scheme:dark){.card{--bg:#1A2030;--ink:#E8ECF4;--mut:#9AA3B5;--line:#2A3245;--price:#FF5A6E;--good:#3CC48F;--tg:#7FA2FF;--soft:#222A3C}}
  .top{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .top b{font-size:13px}
  .x{border:0;background:none;color:var(--mut);cursor:pointer;font-size:15px;padding:2px 6px;border-radius:6px}
  .x:hover{background:var(--soft)}
  .row{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin:8px 0}
  .big{font-family:"Barlow Condensed","Arial Narrow",sans-serif;font-weight:700;font-size:38px;line-height:1;color:var(--price)}
  .big small{font-size:18px}
  .stk{background:var(--stk);color:#1C2541;border-radius:5px;padding:5px 9px;transform:rotate(-3deg);box-shadow:2px 2px 0 #1C2541;max-width:150px}
  .stk.hit{background:var(--tg);color:#fff}
  .stk b{display:block;font-size:13px}.stk span{font-size:11px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:8px 0}
  .stats div{padding:6px 2px}.stats small{display:block;color:var(--mut);font-size:11px}
  .stats strong{font-family:"Barlow Condensed","Arial Narrow",sans-serif;font-size:18px}
  .lowv{color:var(--good)}
  svg .pl{fill:none;stroke:var(--ink);stroke-width:1.8;stroke-linejoin:round}
  svg .minl{stroke:var(--good);stroke-dasharray:4 4;stroke-width:1.2}
  svg .tgl{stroke:var(--tg);stroke-width:1.2}
  svg .cur{fill:var(--price)}
  .tg{display:flex;gap:6px;align-items:center;margin:8px 0}
  .tg input{width:90px;padding:5px 8px;border:1.5px solid var(--line);border-radius:7px;background:transparent;color:var(--ink);font:inherit}
  .btn{border:1.5px solid var(--line);background:transparent;color:var(--ink);border-radius:8px;padding:5px 10px;cursor:pointer;font:inherit}
  .btn:hover{background:var(--soft)}
  .btn.pri{background:var(--ink);color:var(--bg);border-color:var(--ink)}
  .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .mut{color:var(--mut);font-size:12px}
  .warn{color:var(--price)}
  .pill{position:fixed;right:16px;bottom:16px;border:1.5px solid var(--line);background:var(--bg);color:var(--ink);border-radius:999px;padding:7px 14px;cursor:pointer;
    font-family:"Noto Sans TC","PingFang TC",system-ui,sans-serif;font-size:13px;box-shadow:0 4px 14px rgba(15,20,35,.18)}
  .list a{color:var(--ink);text-decoration:none;display:block;padding:7px 4px;border-bottom:1px solid var(--line)}
  .list a:hover{background:var(--soft)}
  .list .n{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .list .hit{color:var(--tg);font-weight:700}
  .list .low{color:var(--good)}
  :focus-visible{outline:2px solid var(--price);outline-offset:2px}
  `;

  const ui = { open: GM_getValue('tbpr_open', true), view: 'item', status: 'waiting', item: null };

  function render() {
    if (!ui.open) {
      const a = ui.item && analyze(ui.item);
      root.innerHTML = `<style>${STYLE}</style><button class="pill card" style="width:auto;padding:7px 14px" id="pill">🏷️ ${a ? '¥' + fmt(a.cur) + '・' + a.v.t : '價格紀錄'}</button>`;
      root.getElementById('pill').onclick = () => { ui.open = true; GM_setValue('tbpr_open', true); render(); };
      return;
    }
    let body = '';
    if (ui.view === 'list') body = listView();
    else if (ui.status === 'waiting') body = `<p class="mut">正在讀取價格…</p>`;
    else if (ui.status === 'notfound') body = `<p class="warn">沒有找到價格。淘寶可能改版了，請按下面的按鈕，再點一下頁面上的價格數字。</p>${actions(false)}`;
    else if (ui.status === 'picking') body = `<p>請點一下頁面上的<b>商品價格數字</b>。按 Esc 取消。</p>`;
    else body = itemView();
    root.innerHTML = `<style>${STYLE}</style><div class="card" role="region" aria-label="價格紀錄">
      <div class="top"><b>${ui.view === 'list' ? '所有已記錄商品' : '價格紀錄'}</b><button class="x" id="close" aria-label="收合">✕</button></div>${body}</div>`;
    root.getElementById('close').onclick = () => { ui.open = false; GM_setValue('tbpr_open', false); render(); };
    bind();
  }

  function actions(full) {
    return `<div class="acts">
      ${full ? '<button class="btn" id="copy">複製歷史價格</button>' : ''}
      <button class="btn" id="all">所有商品</button>
      <button class="btn" id="pick">${full ? '價格不對？重新選取' : '選取價格位置'}</button>
    </div>`;
  }

  function itemView() {
    const it = ui.item, a = analyze(it);
    const tmsg = !it.target ? '' : a.cur <= it.target ? '已低於目標價' : `還差 ¥${fmt(a.cur - it.target)}`;
    return `
      <div class="mut" style="margin-top:4px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(it.name)}</div>
      <div class="row"><div><div class="mut">今天 ${a.pts[a.pts.length - 1].d}</div><div class="big"><small>¥</small>${fmt(a.cur)}</div></div>
        <div class="stk ${a.v.k === 'hit' ? 'hit' : ''}"><b>${a.v.t}</b><span>${esc(a.v.s)}</span></div></div>
      <div class="stats">
        <div><small>歷史最低</small><strong class="lowv">¥${fmt(a.min)}</strong><small>${a.minD}</small></div>
        <div><small>最高</small><strong>¥${fmt(a.max)}</strong></div>
        <div><small>平均</small><strong>¥${fmt(a.avg)}</strong><small>${a.pts.length} 天紀錄</small></div>
      </div>
      ${spark(a, it.target)}
      <div class="tg"><label for="tg">目標價 ¥</label><input id="tg" type="number" step="0.01" min="0" value="${it.target || ''}"><button class="btn" id="tgs">儲存</button><span class="mut">${tmsg}</span></div>
      <p class="mut">記錄的是打開頁面時預設規格的價格；選了別的規格不會重新記錄。</p>
      ${actions(true)}`;
  }

  function listView() {
    const items = Object.entries(load()).map(([id, it]) => ({ id, it, a: analyze(it) })).filter(x => x.a)
      .sort((p, q) => (q.it.updated || 0) - (p.it.updated || 0));
    if (!items.length) return '<p class="mut">還沒有任何紀錄。</p>';
    return `<div class="list">${items.map(({ it, a }) => {
      const tag = a.v.k === 'hit' ? `<span class="hit">已達目標價</span>` : a.v.k === 'low' ? `<span class="low">${a.v.t}</span>` : `最低 ¥${fmt(a.min)}`;
      return `<a href="${esc(it.url)}"><span class="n">${esc(it.name)}</span><span class="mut">¥${fmt(a.cur)}（${a.pts[a.pts.length - 1].d}）・${tag}</span></a>`;
    }).join('')}</div>
    <div class="acts"><button class="btn" id="back">回到這個商品</button><button class="btn" id="exportAll">複製全部資料備份</button></div>`;
  }

  function bind() {
    const $ = id => root.getElementById(id);
    if ($('all')) $('all').onclick = () => { ui.view = 'list'; render(); };
    if ($('back')) $('back').onclick = () => { ui.view = 'item'; render(); };
    if ($('pick')) $('pick').onclick = startPick;
    if ($('copy')) $('copy').onclick = () => {
      const a = analyze(ui.item);
      GM_setClipboard(a.pts.map(p => `${p.d} ${p.p}`).join('\n'));
      $('copy').textContent = '已複製';
    };
    if ($('exportAll')) $('exportAll').onclick = () => { GM_setClipboard(JSON.stringify(load(), null, 1)); $('exportAll').textContent = '已複製'; };
    if ($('tgs')) $('tgs').onclick = () => {
      const v = parseFloat($('tg').value);
      const items = load(); const it = items[itemId]; if (!it) return;
      it.target = v > 0 ? v : null; save(items); ui.item = it; render();
    };
  }

  // ---------- 手動選取價格位置 ----------
  function selectorFor(el) {
    for (const c of el.classList) {
      const m = c.match(/^([A-Za-z]+--[A-Za-z]+)--/); // 淘寶新版 class 帶雜湊，取穩定前綴
      if (m) return `[class*="${m[1]}"]`;
    }
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.classList.length) return '.' + [...el.classList].map(c => CSS.escape(c)).join('.');
    return null;
  }
  function startPick() {
    ui.status = 'picking'; render();
    const onClick = e => {
      if (host.contains(e.target)) return;
      e.preventDefault(); e.stopPropagation();
      cleanup();
      const el = e.target, v = num(el.textContent), s = selectorFor(el);
      if (!(v > 0) || !s) { alert('這個位置讀不到價格數字，請再試一次，點在價格數字本身上。'); ui.status = ui.item ? 'ok' : 'notfound'; render(); return; }
      GM_setValue(SEL_KEY, s);
      ui.item = record(v); ui.status = 'ok'; render();
    };
    const onKey = e => { if (e.key === 'Escape') { cleanup(); ui.status = ui.item ? 'ok' : 'notfound'; render(); } };
    function cleanup() { document.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onKey, true); }
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  // ---------- 啟動：等頁面載入價格，最多 20 秒 ----------
  render();
  let tries = 0;
  const timer = setInterval(() => {
    const v = detectPrice();
    if (v) { clearInterval(timer); ui.item = record(v); ui.status = 'ok'; render(); }
    else if (++tries >= 20) { clearInterval(timer); ui.status = 'notfound'; ui.item = load()[itemId] || null; render(); }
  }, 1000);
})();
