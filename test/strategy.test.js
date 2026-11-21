// 策略层正常结果：两套规则在同一需求版本下的权衡关系、晚到归还对照、
// 以及“不能用未来归还补当时缺箱”的行为级证明。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSampleScenario, AFFECTED_WINDOW } from '../lib/scenario.js';
import { runSimulation } from '../lib/engine.js';
import { runComparison, runLateReturnComparison, runTimeline } from '../lib/compare.js';

test('两套策略在同一事件流上产出同一组 KPI 字段', () => {
  const data = runComparison(buildSampleScenario('baseline'));
  assert.equal(data.runs.length, 2);
  assert.deepEqual(data.runs.map((r) => r.strategyId), ['immediate', 'batch']);
  const keys = Object.keys(data.runs[0].kpi).sort();
  assert.deepEqual(Object.keys(data.runs[1].kpi).sort(), keys);
  for (const run of data.runs) {
    assert.match(run.signature, /^[0-9a-f]{12}$/);
  }
});

test('权衡成立：批量阈值策略空驶更少、发车更少；立即策略缺箱不更多', () => {
  const data = runComparison(buildSampleScenario('baseline'));
  const [imm, bat] = data.runs;
  assert.ok(bat.kpi.emptyMileageKm < imm.kpi.emptyMileageKm,
    '批量策略空驶里程应更低');
  assert.ok(bat.kpi.tripsCount < imm.kpi.tripsCount,
    '批量策略发车趟数应更少');
  assert.ok(imm.kpi.totalShortageMinutes <= bat.kpi.totalShortageMinutes,
    '立即策略缺箱时长不应高于批量策略');
  assert.equal(data.comparison.lowerMileageStrategy, 'batch');
  assert.equal(data.comparison.lowerShortageStrategy, 'immediate');
});

test('样例中确实发生两仓同刻争用，且裁决规则被记录', () => {
  const r = runSimulation(buildSampleScenario('baseline'), 'immediate');
  assert.ok(r.kpi.contentionCount >= 1);
  for (const c of r.contentionLog) {
    assert.ok(['A', 'B'].includes(c.winner));
    assert.ok(Array.isArray(c.losers) && c.losers.length > 0);
    assert.match(c.rule, /积压/);
  }
  // 至少一趟带争用标记的车次
  assert.ok(r.trips.some((t) => t.contended));
});

test('晚到版本：立即策略 KPI 完全不变（不依赖那笔未来归还）', () => {
  const lr = runLateReturnComparison();
  const imm = lr.variants.immediate;
  assert.equal(imm.deltas.totalShortageMinutes, 0);
  assert.equal(imm.deltas.emptyMileageKm, 0);
  assert.equal(imm.deltas.tripsCount, 0);
  assert.equal(imm.deltas.windowShortageMinutes, 0);
  // 签名随事件流变化而变化，证明两个版本确实不同源
  assert.notEqual(imm.baselineSignature, imm.lateSignature);
});

test('晚到版本：批量策略受影响时段缺箱被拉长', () => {
  const lr = runLateReturnComparison();
  const bat = lr.variants.batch;
  assert.ok(bat.deltas.windowShortageMinutes > 0,
    '批量策略在受影响窗口内的缺箱应增加');
  assert.ok(bat.deltas.totalShortageMinutes >= bat.deltas.windowShortageMinutes);
  assert.equal(lr.window.from, AFFECTED_WINDOW.from);
  assert.equal(lr.window.to, AFFECTED_WINDOW.to);
});

test('受影响窗口只统计与窗口相交的缺箱时长', () => {
  const data = runComparison(buildSampleScenario('late'));
  for (const run of data.runs) {
    const windowed = data.comparison.affectedWindow[run.strategyId];
    // 窗口内缺箱不可能超过总缺箱
    assert.ok(windowed.totalMinutes <= run.kpi.totalShortageMinutes);
    // 每个仓的窗口缺箱不超过其总缺箱
    for (const [wh, mins] of Object.entries(windowed.byWarehouse)) {
      assert.ok(mins <= run.kpi.shortageMinutesByWarehouse[wh]);
    }
  }
});

test('未来归还不能补当时缺箱：基线与晚到版本在归还时刻之前的轨迹完全一致', () => {
  // 若引擎偷看未来，晚到版本在 t<70 的决策就会与基线不同；
  // 因果引擎只看当下，因此分割点之前两版的发车时点必须逐趟相同。
  const split = AFFECTED_WINDOW.from;
  for (const strategyId of ['immediate', 'batch']) {
    const base = runSimulation(buildSampleScenario('baseline'), strategyId);
    const late = runSimulation(buildSampleScenario('late'), strategyId);
    const beforeSplit = (r) => r.trips
      .filter((t) => t.dispatchedAt < split)
      .map((t) => `${t.dispatchedAt}:${t.donor}->${t.destination}:${t.quantity}`);
    assert.deepEqual(beforeSplit(base), beforeSplit(late),
      `策略 ${strategyId} 在分割点前不应受未来归还影响`);
  }
});

test('调拨时点接口给出两套策略的完整车次与争用记录', () => {
  const tl = runTimeline(buildSampleScenario('baseline'));
  assert.equal(tl.strategies.length, 2);
  for (const s of tl.strategies) {
    assert.ok(s.trips.length > 0);
    for (const t of s.trips) {
      assert.ok(t.arrivesAt > t.dispatchedAt);
      assert.equal(t.distanceKm, t.emptyLegKm + t.loadLegKm);
    }
  }
});

test('同一场景重复运行结果确定（无随机量）', () => {
  const sc = buildSampleScenario('baseline');
  const a = JSON.stringify(runSimulation(sc, 'batch'));
  const b = JSON.stringify(runSimulation(sc, 'batch'));
  assert.equal(a, b);
});
