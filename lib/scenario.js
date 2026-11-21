// 本地样例场景：两个仓点 A、B 加一个中心仓 D（富余箱源/车辆停靠点），单台车辆。
// 入箱(intake)、租借(rental)、归还(return) 分别入流，事件按时间非降排列。
//
// 两个需求版本共用同一份事件骨架：
//   baseline：B 的 6 箱归还在 t=70 准时到
//   late     ：同一笔归还延迟到 t=100（晚到 30 分钟），其余事件完全一致
// 这样可直接核对“晚到归还”对受影响时段的冲击。

const policy = {
  kmPerMin: 1, // 1 公里 / 分钟，行驶时长在数值上等于距离，便于人工核对
};

const warehouses = [
  // 中心仓：纯箱源（sourceOnly），不承接租借、不产生补箱申请，只作为捐箱方
  {
    id: 'D', initialStock: 30, lowWatermark: 0, orderUpTo: 30,
    batchThreshold: 0, sourceOnly: true,
  },
  { id: 'A', initialStock: 8, lowWatermark: 3, orderUpTo: 8, batchThreshold: 1 },
  { id: 'B', initialStock: 8, lowWatermark: 3, orderUpTo: 8, batchThreshold: 1 },
];

const distances = {
  'D-A': 20,
  'D-B': 30,
  'A-B': 40,
};

const vehicle = { startAt: 'D', capacity: 8 };

// 基线事件流（时间, 仓点, 类型, 数量）
const baselineEvents = [
  { time: 0, warehouse: 'A', type: 'intake', quantity: 2 },
  { time: 10, warehouse: 'A', type: 'rental', quantity: 6 },
  { time: 20, warehouse: 'B', type: 'rental', quantity: 5 },
  { time: 30, warehouse: 'A', type: 'rental', quantity: 6 },
  { time: 40, warehouse: 'A', type: 'return', quantity: 4 },
  { time: 45, warehouse: 'B', type: 'rental', quantity: 6 },
  { time: 70, warehouse: 'B', type: 'return', quantity: 6 }, // 准时归还
  { time: 80, warehouse: 'A', type: 'rental', quantity: 10 },
  { time: 80, warehouse: 'B', type: 'rental', quantity: 10 }, // 同刻双仓抢一个车次
  { time: 130, warehouse: 'A', type: 'return', quantity: 10 },
  { time: 150, warehouse: 'B', type: 'rental', quantity: 2 },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildScenario(variant) {
  const events = clone(baselineEvents);
  let lateReturn = null;
  if (variant === 'late') {
    const target = events.find(
      (ev) => ev.time === 70 && ev.warehouse === 'B' && ev.type === 'return',
    );
    target.time = 100; // 晚到 30 分钟
    // 移动后重新按时间稳定排序（同刻保持数组原序，即 A 先于 B）
    events.sort((x, y) => x.time - y.time);
    lateReturn = {
      warehouse: 'B',
      originalTime: 70,
      revisedTime: 100,
      quantity: 6,
      delayMinutes: 30,
    };
  }
  return {
    name: variant === 'late' ? '本地样例（含晚到归还）' : '本地样例（基线）',
    variant,
    warehouses: clone(warehouses),
    distances: clone(distances),
    vehicle: clone(vehicle),
    policy: clone(policy),
    events,
    horizon: 200,
    lateReturn,
  };
}

export function buildSampleScenario(variant = 'baseline') {
  if (variant !== 'baseline' && variant !== 'late') {
    throw new Error(`未知样例版本: ${String(variant)}，仅支持 baseline / late`);
  }
  return buildScenario(variant);
}

// 晚到归还对照的受影响时段（半开区间 [from, to)）
export const AFFECTED_WINDOW = { from: 70, to: 100 };
