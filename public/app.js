// 前端交互：三个按钮分别调用三个 API，结果写入带 data-evidence-result 的业务结果区。
// 同一次会话内三个面板同时保留，可来回核对；每次渲染附带后端校验签名。

const $ = (sel) => document.querySelector(sel);

const STRATEGY_META = {
  immediate: { name: '低水位立即调拨', cls: 's1', pill: 'pill s1' },
  batch: { name: '批量阈值调拨', cls: 's2', pill: 'pill s2' },
};

async function callApi(url, options) {
  const res = await fetch(url, options);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

function setStatus(text, isError = false) {
  const el = $('#action-status');
  el.textContent = text;
  el.style.color = isError ? 'var(--critical)' : 'var(--text-muted)';
}

function flashPanel(selector) {
  const panel = document.querySelector(selector);
  panel.classList.remove('flash');
  // 强制重绘以重放高亮动画
  void panel.offsetWidth;
  panel.classList.add('flash');
  setTimeout(() => panel.classList.remove('flash'), 900);
}

function renderInto(selector, html) {
  const panel = $(selector);
  panel.querySelector('.placeholder').hidden = true;
  const body = panel.querySelector('.panel-body');
  body.hidden = false;
  body.innerHTML = html;
  flashPanel(selector);
}

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function deltaCell(value, unit = '', goodWhenZero = false) {
  if (value === 0) {
    return `<span class="delta-zero">0${unit}（无变化）</span>`;
  }
  const cls = goodWhenZero ? 'delta-pos' : (value < 0 ? 'delta-good' : 'delta-pos');
  const sign = value > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${value}${unit}</span>`;
}

// ---- ① 基准策略对照 ----
function renderBaseline(data) {
  const [imm, bat] = data.runs;
  const cmp = data.comparison;
  const maxShortage = Math.max(1, ...data.runs.map((r) => r.kpi.totalShortageMinutes));
  const maxEmpty = Math.max(1, ...data.runs.map((r) => r.kpi.emptyMileageKm));

  const tiles = data.runs.map((r) => `
    <div class="stat-tile ${STRATEGY_META[r.strategyId].cls}">
      <div class="label">${esc(r.strategyName)}</div>
      <div class="value">${r.kpi.totalShortageMinutes}<span class="unit"> 分钟缺箱</span></div>
      <div class="label">空驶 ${r.kpi.emptyMileageKm} km · 发车 ${r.kpi.tripsCount} 趟 · 争用 ${r.kpi.contentionCount} 次</div>
    </div>`).join('');

  const meter = (label, vals, max, unit) => data.runs.map((r, i) => `
    <div class="meter">
      <div>${i === 0 ? label : ''}</div>
      <div class="track"><div class="fill ${STRATEGY_META[r.strategyId].cls}"
        style="width:${(vals[i] / max * 100).toFixed(1)}%"></div></div>
      <div class="mval">${vals[i]} ${unit}</div>
    </div>`).join('');

  const winMark = (strategyId, winnerId) =>
    (strategyId === winnerId ? 'win' : '');

  const rows = [
    ['总缺箱时长（分钟）', 'totalShortageMinutes', cmp.lowerShortageStrategy, ''],
    ['空驶里程（km）', 'emptyMileageKm', cmp.lowerMileageStrategy, ''],
    ['重载里程（km）', 'loadedMileageKm', null, ''],
    ['发车趟数', 'tripsCount', null, ''],
    ['争用次数', 'contentionCount', null, ''],
  ].map(([label, key, winner]) => `
    <tr>
      <td>${label}</td>
      <td class="num ${winner ? winMark(imm.strategyId, winner) : ''}">${imm.kpi[key]}</td>
      <td class="num ${winner ? winMark(bat.strategyId, winner) : ''}">${bat.kpi[key]}</td>
    </tr>`).join('');

  renderInto('[data-evidence-result="baseline-comparison"]', `
    <div class="legend">
      <span><span class="swatch s1"></span>${esc(imm.strategyName)}</span>
      <span><span class="swatch s2"></span>${esc(bat.strategyName)}</span>
    </div>
    <div class="stat-row">${tiles}</div>
    <h3>同尺规对比条</h3>
    ${meter('缺箱时长', data.runs.map((r) => r.kpi.totalShortageMinutes), maxShortage, '分钟')}
    ${meter('空驶里程', data.runs.map((r) => r.kpi.emptyMileageKm), maxEmpty, 'km')}
    <h3>逐项 KPI 对照（✓ 为该项更优）</h3>
    <table>
      <thead><tr><th>指标</th><th class="num">立即调拨</th><th class="num">批量阈值</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="callout">
      权衡结论：批量策略比立即策略少 <strong>${-cmp.emptyMileageDeltaKm} km</strong> 空驶、
      少 <strong>${-cmp.tripsDelta}</strong> 趟发车；缺箱时长差
      <strong>${cmp.shortageDeltaMinutes} 分钟</strong>（正数表示批量策略缺得更久）。<br/>
      缺箱更短：<strong>${esc(STRATEGY_META[cmp.lowerShortageStrategy].name)}</strong>；
      里程更省：<strong>${esc(STRATEGY_META[cmp.lowerMileageStrategy].name)}</strong>。
    </div>
    <p class="signature">场景签名 immediate=${imm.signature} · batch=${bat.signature}</p>
  `);
}

// ---- ② 晚到归还对照 ----
function renderLate(data) {
  const { lateReturn, window, variants } = data;
  const cards = Object.values(variants).map((v) => {
    const d = v.deltas;
    return `
      <div class="stat-tile ${STRATEGY_META[v.strategyId].cls}">
        <div class="label">${esc(v.strategyName)}</div>
        <div class="value">${deltaCell(d.totalShortageMinutes, ' 分钟')}</div>
        <div class="label">总缺箱变化（晚到 − 基线）</div>
        <hr style="border:none;border-top:1px solid var(--gridline);margin:8px 0" />
        <div class="label">受影响时段 [${window.from}, ${window.to}) 缺箱：
          ${v.baselineWindowShortage.totalMinutes} → ${v.lateWindowShortage.totalMinutes} 分钟
          （${deltaCell(d.windowShortageMinutes, ' 分钟')}）</div>
        <div class="label">空驶变化 ${deltaCell(d.emptyMileageKm, ' km')} ·
          发车 ${deltaCell(d.tripsCount, ' 趟')} · 争用 ${deltaCell(d.contentionCount, ' 次')}</div>
      </div>`;
  }).join('');

  const tableRows = Object.values(variants).map((v) => `
    <tr>
      <td><span class="${STRATEGY_META[v.strategyId].pill}">${esc(v.strategyName)}</span></td>
      <td class="num">${v.baselineKpi.totalShortageMinutes}</td>
      <td class="num">${v.lateKpi.totalShortageMinutes}</td>
      <td class="num">${deltaCell(v.deltas.totalShortageMinutes, ' 分钟')}</td>
      <td class="num">${v.baselineWindowShortage.totalMinutes}</td>
      <td class="num">${v.lateWindowShortage.totalMinutes}</td>
      <td class="num">${deltaCell(v.deltas.windowShortageMinutes, ' 分钟')}</td>
      <td class="num">${deltaCell(v.deltas.emptyMileageKm, ' km')}</td>
    </tr>`).join('');

  renderInto('[data-evidence-result="late-return-comparison"]', `
    <div class="callout warn">
      晚到事件：仓点 <strong>${esc(lateReturn.warehouse)}</strong> 的 ${lateReturn.quantity} 箱归还，
      原定 t=${lateReturn.originalTime}，实际 t=${lateReturn.revisedTime}
      （晚到 ${lateReturn.delayMinutes} 分钟）。受影响时段取半开区间
      <strong>[${window.from}, ${window.to})</strong>，只统计与该窗口相交的缺箱时段。
    </div>
    <div class="stat-row">${cards}</div>
    <table>
      <thead><tr>
        <th>策略</th><th class="num">基线总缺箱</th><th class="num">晚到总缺箱</th><th class="num">差值</th>
        <th class="num">窗口内基线</th><th class="num">窗口内晚到</th><th class="num">窗口差值</th>
        <th class="num">空驶差</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
    <p class="muted" style="font-size:13px">
      解读：立即策略按低水位主动补箱，不依赖该笔归还，因此晚到对其 KPI 无冲击；
      批量策略在等待中把希望寄托于归还，晚到直接拉长受影响时段的缺箱。
    </p>
    <p class="signature">基线/晚到签名：
      ${Object.values(variants).map((v) => `${v.strategyId}=${v.baselineSignature}/${v.lateSignature}`).join(' · ')}</p>
  `);
}

// ---- ③ 调拨时点时间线 ----
function renderTimeline(data) {
  const maxT = Math.max(data.horizon ?? 0,
    ...data.strategies.flatMap((s) => s.trips.map((t) => t.arrivesAt)));
  const pct = (t) => (t / maxT * 100).toFixed(2);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const t = Math.round(maxT * f);
    return `<span class="tl-tick" style="left:calc(96px + (100% - 96px) * ${f})">t=${t}</span>`;
  }).join('');

  const lanes = data.strategies.map((s) => {
    const segs = s.trips.map((t) => `
      <div class="tl-seg ${t.contended ? 'contended' : ''}"
        style="left:${pct(t.dispatchedAt)}%;width:${Math.max(2, (t.arrivesAt - t.dispatchedAt) / maxT * 100)}%"
        title="${esc(t.donor)}→${esc(t.destination)} ${t.quantity}箱">
        ${esc(t.donor)}→${esc(t.destination)}×${t.quantity}${t.contended ? ' ⚠' : ''}
        <span class="tip">
          车次 ${t.id}<br/>
          发车 t=${t.dispatchedAt} → 到达 t=${t.arrivesAt}<br/>
          ${esc(t.donor)} → ${esc(t.destination)}，载 ${t.quantity} 箱（容量 ${t.capacity}）<br/>
          空驶段 ${t.emptyLegKm} km + 重载段 ${t.loadLegKm} km<br/>
          ${t.contended ? `争用车次：同刻负方 [${t.waitingWarehouses.join(', ')}] 排队等候<br/>` : ''}
          原因：${esc(t.reason)}
        </span>
      </div>`).join('');

    const eps = s.shortageEpisodes.map((e) => `
      <div class="tl-episode" style="left:${pct(e.start)}%;width:${Math.max(1, (e.end - e.start) / maxT * 100)}%"
        title="缺箱 ${e.warehouse}：t=${e.start}→t=${e.end}（${e.durationMinutes}分钟，峰值积压${e.peakBacklog}）"></div>`
    ).join('');

    return `
      <div class="tl-lane ${s.strategyId === 'batch' ? 'batch' : ''}">
        <span class="lane-name">${esc(s.strategyName)}</span>
        <div class="lane-track">${segs}${eps}</div>
      </div>`;
  }).join('');

  const detailRows = data.strategies.flatMap((s) => s.trips.map((t) => `
    <tr>
      <td><span class="${STRATEGY_META[s.strategyId].pill}">${s.strategyId}</span></td>
      <td class="num">${t.id}</td>
      <td class="num">${t.dispatchedAt}</td>
      <td class="num">${t.arrivesAt}</td>
      <td>${esc(t.donor)} → ${esc(t.destination)}</td>
      <td class="num">${t.quantity}</td>
      <td class="num">${t.emptyLegKm}</td>
      <td class="num">${t.loadLegKm}</td>
      <td>${t.contended ? `<span class="pill warn">争用，负方[${t.waitingWarehouses.join(',')}]</span>` : '—'}</td>
    </tr>`)).join('');

  const contentions = data.strategies.flatMap((s) =>
    s.contentionLog.map((c) => `
      <tr>
        <td><span class="${STRATEGY_META[s.strategyId].pill}">${s.strategyId}</span></td>
        <td class="num">t=${c.time}</td>
        <td><strong>${esc(c.winner)}</strong> 胜出（当时积压 ${c.winnerBacklog}）</td>
        <td>[${c.losers.map(esc).join(', ')}] 排队</td>
        <td>${esc(c.rule)}</td>
      </tr>`)).join('');

  renderInto('[data-evidence-result="dispatch-timeline"]', `
    <p class="muted" style="font-size:13px">
      横条为车次（左端发车、右端到达；虚线描边＝争用车次），红色短条为缺箱时段。悬停查看明细。
    </p>
    <div class="tl-axis">${ticks}</div>
    ${lanes}
    <h3>逐趟调拨明细</h3>
    <table>
      <thead><tr>
        <th>策略</th><th class="num">车次</th><th class="num">发车 t</th><th class="num">到达 t</th>
        <th>路径</th><th class="num">箱量</th><th class="num">空驶km</th><th class="num">重载km</th><th>争用</th>
      </tr></thead>
      <tbody>${detailRows}</tbody>
    </table>
    <h3>争用裁决记录</h3>
    <table>
      <thead><tr><th>策略</th><th class="num">时刻</th><th>胜方</th><th>负方</th><th>裁决规则</th></tr></thead>
      <tbody>${contentions || '<tr><td colspan="5" class="muted">无争用</td></tr>'}</tbody>
    </table>
    <p class="signature">签名：${data.strategies.map((s) => `${s.strategyId}=${s.signature}`).join(' · ')}</p>
  `);
}

// ---- 样例输入展示 ----
async function renderScenarioInput() {
  const baseline = await callApi('/api/sample?variant=baseline');
  const late = await callApi('/api/sample?variant=late');
  const chip = (ev) => `
    <span class="event-chip ${ev.type}">t=${ev.time} ${esc(ev.warehouse)}
      ${ev.type === 'intake' ? '入箱' : ev.type === 'rental' ? '租借' : '归还'}×${ev.quantity}</span>`;
  $('#scenario-input').innerHTML = `
    <p style="margin-top:0">
      仓点：${baseline.warehouses.map((w) => `${esc(w.id)}（初始${w.initialStock}箱，低水位${w.lowWatermark}，目标${w.orderUpTo}${w.sourceOnly ? '，纯箱源' : ''}）`).join('；')}<br/>
      车辆：容量 ${baseline.vehicle.capacity} 箱，初始停靠 ${esc(baseline.vehicle.startAt)}；
      速度 ${baseline.policy.kmPerMin} km/分钟。
    </p>
    <p><strong>基线事件流（${baseline.events.length} 条）：</strong></p>
    <div>${baseline.events.map(chip).join('')}</div>
    <p><strong>晚到版本差异：</strong>${esc(late.lateReturn.warehouse)} 的归还
      t=${late.lateReturn.originalTime} → t=${late.lateReturn.revisedTime}
      （晚 ${late.lateReturn.delayMinutes} 分钟），其余事件完全相同。</p>
  `;
}

async function bindButtons() {
  const buttons = [
    ['#btn-baseline', '[data-evidence-result="baseline-comparison"]', async () => {
      const scenario = await callApi('/api/sample?variant=baseline');
      return callApi('/api/compare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(scenario),
      });
    }, renderBaseline, '基准策略对照已刷新'],
    ['#btn-late', '[data-evidence-result="late-return-comparison"]',
      () => callApi('/api/late-return'), renderLate, '晚到归还对照已刷新'],
    ['#btn-timeline', '[data-evidence-result="dispatch-timeline"]',
      () => callApi('/api/timeline?variant=baseline'), renderTimeline, '调拨时点已刷新'],
  ];

  for (const [btnSel, panelSel, loader, renderer, okText] of buttons) {
    $(btnSel).addEventListener('click', async () => {
      const btn = $(btnSel);
      btn.disabled = true;
      setStatus('计算中…');
      try {
        const data = await loader();
        renderer(data);
        setStatus(`${okText}（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`);
      } catch (err) {
        setStatus(`操作失败：${err.message}`, true);
        const panel = $(panelSel);
        panel.querySelector('.panel-body').hidden = true;
        const ph = panel.querySelector('.placeholder');
        ph.hidden = false;
        ph.textContent = `计算失败：${err.message}`;
      } finally {
        btn.disabled = false;
      }
    });
  }
}

renderScenarioInput().catch((err) => {
  $('#scenario-input').innerHTML = `<p class="muted">样例加载失败：${esc(err.message)}</p>`;
});
bindButtons();
