// 引擎正常结果覆盖：用可手算的小场景对 KPI、事件流、争用裁决做精确断言，
// 并验证核心因果性——策略快照里没有任何未来事件字段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSimulation } from '../lib/engine.js';

// 可手算小场景：两仓 A/B + 中心仓 D，单车容量 5，速度 1km/分钟
function tinyScenario() {
  return {
    name: '手算小场景',
    warehouses: [
      { id: 'D', initialStock: 20, lowWatermark: 0, orderUpTo: 20, batchThreshold: 0, sourceOnly: true },
      { id: 'A', initialStock: 5, lowWatermark: 2, orderUpTo: 5, batchThreshold: 0 },
      { id: 'B', initialStock: 5, lowWatermark: 2, orderUpTo: 5, batchThreshold: 0 },
    ],
    distances: { 'D-A': 10, 'D-B': 20, 'A-B': 25 },
    vehicle: { startAt: 'D', capacity: 5 },
    policy: { kmPerMin: 1 },
    horizon: 200,
    events: [
      { time: 0, warehouse: 'A', type: 'intake', quantity: 1 },
      { time: 10, warehouse: 'A', type: 'rental', quantity: 8 }, // 满足6，缺2
      { time: 10, warehouse: 'B', type: 'rental', quantity: 8 }, // 满足5，缺3（同刻争用，B 积压更大）
      { time: 30, warehouse: 'A', type: 'return', quantity: 4 },
    ],
  };
}

test('入箱、租借、归还分别计入事件时间线', () => {
  const r = runSimulation(tinyScenario(), 'immediate');
  const types = r.eventTimeline.map((e) => e.type);
  assert.deepEqual(types, ['intake', 'rental', 'rental', 'return']);
  assert.ok(r.eventTimeline.every((e) => e.status === 'processed'));
});

test('入箱与归还先清偿租借积压（FIFO），并精确记录满足/未满足量', () => {
  const r = runSimulation(tinyScenario(), 'immediate');
  const [intake, rentA, rentB, ret] = r.eventTimeline;

  assert.equal(intake.stockAfter, 6); // A: 5 + 1
  assert.equal(rentA.servedQuantity, 6);
  assert.equal(rentA.unservedQuantity, 2);
  assert.equal(rentB.servedQuantity, 5);
  assert.equal(rentB.unservedQuantity, 3);

  // t=30 A 归还 4：先清 2 箱积压，剩余 2 箱入库存
  assert.equal(ret.backlogCleared, 2);
  assert.equal(ret.stockAfter, 2);
  assert.equal(ret.backlogAfter, 0);
});

test('缺箱时段时长精确：A 缺 20 分钟（t10→t30），B 等到调拨到达', () => {
  const r = runSimulation(tinyScenario(), 'immediate');
  const epA = r.shortageEpisodes.find((e) => e.warehouse === 'A');
  assert.equal(epA.start, 10);
  assert.equal(epA.end, 30);
  assert.equal(epA.durationMinutes, 20);
  assert.equal(epA.peakBacklog, 2);
  assert.equal(r.kpi.shortageMinutesByWarehouse.A, 20);
  assert.ok(r.kpi.totalShortageMinutes >= 20);
});

test('同刻双仓抢一个车次：积压更大的 B 胜出，负方排队且产生争用日志', () => {
  const r = runSimulation(tinyScenario(), 'immediate');
  assert.ok(r.kpi.contentionCount >= 1);
  const first = r.contentionLog[0];
  assert.equal(first.winner, 'B'); // B 积压 3 > A 积压 2
  assert.deepEqual(first.losers, ['A']);

  const firstTrip = r.trips[0];
  assert.equal(firstTrip.destination, 'B');
  assert.equal(firstTrip.contended, true);
  assert.deepEqual(firstTrip.waitingWarehouses, ['A']);
  // 车辆初始在 D，捐箱方也是 D，首趟无空驶段
  assert.equal(firstTrip.emptyLegKm, 0);
  assert.equal(firstTrip.loadLegKm, 20);
});

test('调拨箱量受车辆容量与捐箱富余双重限制，不超发', () => {
  const r = runSimulation(tinyScenario(), 'immediate');
  for (const trip of r.trips) {
    assert.ok(trip.quantity <= 5, '不能超过车辆容量 5');
    assert.ok(trip.quantity > 0);
  }
});

test('空驶里程 = 各车次空驶段之和；总里程 = 空驶 + 重载', () => {
  const r = runSimulation(tinyScenario(), 'immediate');
  const expectedEmpty = r.trips.reduce((s, t) => s + t.emptyLegKm, 0);
  const expectedLoaded = r.trips.reduce((s, t) => s + t.loadLegKm, 0);
  assert.equal(r.kpi.emptyMileageKm, expectedEmpty);
  assert.equal(r.kpi.loadedMileageKm, expectedLoaded);
  assert.equal(r.kpi.totalMileageKm, expectedEmpty + expectedLoaded);
});

test('到达时刻 = 发车时刻 + 行驶时长，且按时间顺序排列', () => {
  const r = runSimulation(tinyScenario(), 'immediate');
  for (const t of r.trips) {
    assert.equal(
      t.arrivesAt,
      t.dispatchedAt + t.travelMinutes,
    );
  }
  const arrivals = r.trips.map((t) => t.arrivesAt);
  assert.deepEqual(arrivals, [...arrivals].sort((a, b) => a - b));
});

test('纯箱源仓 D 从不产生补箱申请（无 A→D 回补之类的反向调拨）', () => {
  const r = runSimulation(tinyScenario(), 'immediate');
  assert.ok(r.trips.every((t) => t.destination !== 'D'));
  assert.equal(r.kpi.shortageMinutesByWarehouse.D, 0);
});

test('因果性：策略快照只含当前时刻状态，结构上不含未来事件', async () => {
  const sc = tinyScenario();
  const { strategies } = await import('../lib/strategies.js');
  const seenSnapshots = [];
  const original = strategies.immediate.decide.bind(strategies.immediate);
  strategies.immediate.decide = (snapshot) => {
    seenSnapshots.push(snapshot);
    return original(snapshot);
  };
  try {
    runSimulation(sc, 'immediate');
  } finally {
    strategies.immediate.decide = original;
  }
  assert.ok(seenSnapshots.length > 0);
  for (const snap of seenSnapshots) {
    // 快照允许的键是封闭集合；任何 events/future 类字段都不允许出现
    const allowed = new Set([
      'warehouseId', 'time', 'stock', 'backlog', 'incoming',
      'lowWatermark', 'orderUpTo', 'batchThreshold', 'vehicle',
    ]);
    for (const key of Object.keys(snap)) {
      assert.ok(allowed.has(key), `快照出现越权字段: ${key}`);
      assert.ok(!/event|future|forecast/i.test(key));
    }
    assert.deepEqual(Object.keys(snap.vehicle).sort(),
      ['busy', 'capacity', 'freeAt', 'location'].sort());
  }
});

test('无箱可补时申请保留到终止，计入 unmetRequests 而非死循环', () => {
  const sc = tinyScenario();
  sc.warehouses[0].initialStock = 0; // 中心仓无箱
  const r = runSimulation(sc, 'batch');
  assert.ok(r.kpi.unmetRequests >= 1);
  assert.equal(r.trips.length, 0);
  // 缺箱时段在 horizon 截断
  assert.ok(r.shortageEpisodes.every((e) => e.end <= r.horizon));
});

test('引擎不修改入参场景（纯函数式重放）', () => {
  const sc = tinyScenario();
  const before = JSON.stringify(sc);
  runSimulation(sc, 'immediate');
  assert.equal(JSON.stringify(sc), before);
});
