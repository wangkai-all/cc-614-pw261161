// 策略对照：同一需求版本（同一场景事件流）下跑两套调拨规则，
// 输出可并排核对的 KPI；并提供晚到归还受影响时段的缺箱对照与结果校验签名。

import { createHash } from 'node:crypto';
import { runSimulation } from './engine.js';
import { STRATEGY_IDS, strategies } from './strategies.js';
import { AFFECTED_WINDOW, buildSampleScenario } from './scenario.js';
import { validateScenario } from './validation.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// 对“场景事件流 + KPI”生成稳定签名，便于核对前后两次操作的数据是否同源
export function resultSignature(scenario, kpi) {
  const payload = JSON.stringify({
    events: scenario.events,
    kpi,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 12);
}

function runOne(scenario, strategyId) {
  const result = runSimulation(scenario, strategyId);
  result.signature = resultSignature(scenario, result.kpi);
  return result;
}

// 统计缺箱时段与窗口 [from, to) 的交集长度
function shortageInWindow(episodes, window) {
  let total = 0;
  const byWarehouse = {};
  for (const ep of episodes) {
    const overlap = Math.max(0, Math.min(ep.end, window.to) - Math.max(ep.start, window.from));
    if (overlap > 0) {
      total += overlap;
      byWarehouse[ep.warehouse] = (byWarehouse[ep.warehouse] ?? 0) + overlap;
    }
  }
  return { window, totalMinutes: total, byWarehouse };
}

/**
 * 在同一场景上跑全部策略。
 * @returns {{scenario, window, runs, comparison}}
 */
export function runComparison(inputScenario) {
  const scenario = clone(inputScenario);
  validateScenario(scenario);

  const runs = STRATEGY_IDS.map((id) => runOne(scenario, id));
  const [immediate, batch] = runs;

  const window = scenario.lateReturn
    ? {
        from: scenario.lateReturn.originalTime,
        to: scenario.lateReturn.revisedTime,
      }
    : AFFECTED_WINDOW;

  const comparison = {
    lowerShortageStrategy: immediate.kpi.totalShortageMinutes <= batch.kpi.totalShortageMinutes
      ? immediate.strategyId
      : batch.strategyId,
    lowerMileageStrategy: immediate.kpi.emptyMileageKm <= batch.kpi.emptyMileageKm
      ? immediate.strategyId
      : batch.strategyId,
    shortageDeltaMinutes: batch.kpi.totalShortageMinutes - immediate.kpi.totalShortageMinutes,
    emptyMileageDeltaKm: batch.kpi.emptyMileageKm - immediate.kpi.emptyMileageKm,
    tripsDelta: batch.kpi.tripsCount - immediate.kpi.tripsCount,
    affectedWindow: {
      immediate: shortageInWindow(immediate.shortageEpisodes, window),
      batch: shortageInWindow(batch.shortageEpisodes, window),
    },
  };

  return { scenario, window, runs, comparison };
}

/**
 * 晚到归还对照：同一事件骨架的两个版本，分别跑两套策略，
 * 并给出受影响时段（原归还时刻 → 实际归还时刻）内的缺箱差异。
 */
export function runLateReturnComparison() {
  const baseline = runComparison(buildSampleScenario('baseline'));
  const late = runComparison(buildSampleScenario('late'));

  const window = AFFECTED_WINDOW;
  const variants = {};
  for (const id of STRATEGY_IDS) {
    const baseRun = baseline.runs.find((r) => r.strategyId === id);
    const lateRun = late.runs.find((r) => r.strategyId === id);
    variants[id] = {
      strategyId: id,
      strategyName: strategies[id].name,
      baselineKpi: baseRun.kpi,
      lateKpi: lateRun.kpi,
      baselineWindowShortage: shortageInWindow(baseRun.shortageEpisodes, window),
      lateWindowShortage: shortageInWindow(lateRun.shortageEpisodes, window),
      deltas: {
        totalShortageMinutes: lateRun.kpi.totalShortageMinutes - baseRun.kpi.totalShortageMinutes,
        emptyMileageKm: lateRun.kpi.emptyMileageKm - baseRun.kpi.emptyMileageKm,
        tripsCount: lateRun.kpi.tripsCount - baseRun.kpi.tripsCount,
        contentionCount: lateRun.kpi.contentionCount - baseRun.kpi.contentionCount,
        windowShortageMinutes: shortageInWindow(lateRun.shortageEpisodes, window).totalMinutes
          - shortageInWindow(baseRun.shortageEpisodes, window).totalMinutes,
      },
      baselineSignature: baseRun.signature,
      lateSignature: lateRun.signature,
    };
  }

  return {
    window,
    lateReturn: late.scenario.lateReturn,
    variants,
  };
}

/**
 * 调拨时点：返回两套策略各自的发车/到达时间线（供「查看调拨时点」按钮使用）。
 */
export function runTimeline(inputScenario) {
  const scenario = clone(inputScenario);
  validateScenario(scenario);
  return {
    scenarioName: scenario.name,
    variant: scenario.variant ?? null,
    horizon: scenario.horizon ?? null,
    window: scenario.lateReturn
      ? { from: scenario.lateReturn.originalTime, to: scenario.lateReturn.revisedTime }
      : AFFECTED_WINDOW,
    strategies: STRATEGY_IDS.map((id) => {
      const result = runOne(scenario, id);
      return {
        strategyId: id,
        strategyName: strategies[id].name,
        signature: result.signature,
        trips: result.trips,
        contentionLog: result.contentionLog,
        shortageEpisodes: result.shortageEpisodes,
      };
    }),
  };
}
