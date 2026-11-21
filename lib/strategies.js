// 调拨策略集合。
// 关键约束：decide() 只接收“当前时刻”的状态快照，快照中不包含任何未来事件，
// 因此策略不可能用未来的归还量来弥补当前缺箱——是否补箱完全由当下水位/积压决定。

/**
 * 计算补到目标水位所需的箱量；返回 null 表示无需申请。
 * effective = 在手库存 + 在途量（已发车但尚未到达的箱）
 */
function computeNeed(snapshot) {
  const effective = snapshot.stock + snapshot.incoming;
  const need = snapshot.orderUpTo + snapshot.backlog - effective;
  return Number.isFinite(need) && need > 0 ? need : null;
}

export const STRATEGY_IDS = ['immediate', 'batch'];

export const strategies = {
  // 低水位立即调拨：有效库存一跌破低水位（或已出现租借积压）立刻申请，补到目标水位
  immediate: {
    id: 'immediate',
    name: '低水位立即调拨',
    decide(snapshot) {
      if (snapshot.backlog > 0 || snapshot.stock + snapshot.incoming <= snapshot.lowWatermark) {
        return computeNeed(snapshot);
      }
      return null;
    },
  },

  // 批量阈值调拨：继续等，直到有效库存降到批量阈值（容忍先产生积压）才一次性补到目标水位，
  // 倾向于凑大批量、减少发车次数，从而压低空驶里程
  batch: {
    id: 'batch',
    name: '批量阈值调拨',
    decide(snapshot) {
      if (snapshot.backlog > 0 || snapshot.stock + snapshot.incoming <= snapshot.batchThreshold) {
        return computeNeed(snapshot);
      }
      return null;
    },
  },
};

export function getStrategy(strategyId) {
  const strategy = strategies[strategyId];
  if (!strategy) {
    throw new Error(`未知调拨策略: ${String(strategyId)}，可选值 ${STRATEGY_IDS.join(' / ')}`);
  }
  return strategy;
}
