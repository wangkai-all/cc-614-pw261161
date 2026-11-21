// 异常结果覆盖：场景校验必须拒绝各类非法输入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScenario } from '../lib/validation.js';
import { buildSampleScenario } from '../lib/scenario.js';

function baseScenario() {
  return buildSampleScenario('baseline');
}

test('合法样例场景通过校验', () => {
  assert.equal(validateScenario(baseScenario()), true);
  assert.equal(validateScenario(buildSampleScenario('late')), true);
});

test('场景不是对象时抛错', () => {
  assert.throws(() => validateScenario(null), /场景必须是一个对象/);
  assert.throws(() => validateScenario('nope'), /场景必须是一个对象/);
  assert.throws(() => validateScenario([]), /场景必须是一个对象/);
});

test('仓点少于两个被拒绝', () => {
  const sc = baseScenario();
  sc.warehouses = [sc.warehouses[0]];
  assert.throws(() => validateScenario(sc), /至少需要两个仓点/);
});

test('仓点 id 重复被拒绝', () => {
  const sc = baseScenario();
  sc.warehouses[1].id = sc.warehouses[0].id;
  assert.throws(() => validateScenario(sc), /id 重复/);
});

test('负初始库存与零容量车辆被拒绝', () => {
  const sc = baseScenario();
  sc.warehouses[1].initialStock = -1;
  sc.vehicle.capacity = 0;
  assert.throws(() => validateScenario(sc), (err) =>
    err.validationErrors.some((m) => m.includes('initialStock')) &&
    err.validationErrors.some((m) => m.includes('capacity')));
});

test('批量阈值高于目标水位被拒绝', () => {
  const sc = baseScenario();
  sc.warehouses[1].batchThreshold = 99;
  assert.throws(() => validateScenario(sc), /batchThreshold 不能高于 orderUpTo/);
});

test('未知仓点引用（车辆起点/事件/距离）被拒绝', () => {
  const sc1 = baseScenario();
  sc1.vehicle.startAt = 'X';
  assert.throws(() => validateScenario(sc1), /startAt 引用了未知仓点/);

  const sc2 = baseScenario();
  sc2.events[0].warehouse = 'X';
  assert.throws(() => validateScenario(sc2), /warehouse 引用了未知仓点/);

  const sc3 = baseScenario();
  sc3.distances['X-A'] = 10;
  assert.throws(() => validateScenario(sc3), /引用了未知仓点/);
});

test('自环距离与非正距离被拒绝', () => {
  const sc = baseScenario();
  sc.distances['A-A'] = 0;
  assert.throws(() => validateScenario(sc), (err) =>
    err.validationErrors.some((m) => m.includes('自环')) &&
    err.validationErrors.some((m) => m.includes('必须是正数')));
});

test('缺少仓点间距离配置被拒绝', () => {
  const sc = baseScenario();
  delete sc.distances['A-B'];
  assert.throws(() => validateScenario(sc), /缺少距离配置/);
});

test('非法事件类型与非正数量被拒绝', () => {
  const sc = baseScenario();
  sc.events[0].type = 'teleport';
  sc.events[1].quantity = 0;
  assert.throws(() => validateScenario(sc), (err) =>
    err.validationErrors.some((m) => m.includes('type 非法')) &&
    err.validationErrors.some((m) => m.includes('quantity 必须是正整数')));
});

test('时间倒流被拒绝', () => {
  const sc = baseScenario();
  sc.events[3].time = 5; // 排在 t=20 事件之后却回到 t=5
  assert.throws(() => validateScenario(sc), /时间倒流/);
});

test('晚到版本经重新排序后仍合法', () => {
  const late = buildSampleScenario('late');
  const times = late.events.map((e) => e.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.doesNotThrow(() => validateScenario(late));
  assert.equal(late.lateReturn.delayMinutes, 30);
});

test('非正速度与空事件列表被拒绝', () => {
  const sc1 = baseScenario();
  sc1.policy.kmPerMin = 0;
  assert.throws(() => validateScenario(sc1), /kmPerMin/);

  const sc2 = baseScenario();
  sc2.events = [];
  assert.throws(() => validateScenario(sc2), /events 必须是非空数组/);
});

test('未知策略 id 在运行时报错', async () => {
  // 引擎层的防御：校验通过后仍可能传错策略
  const sc = baseScenario();
  const { runSimulation } = await import('../lib/engine.js');
  assert.throws(() => runSimulation(sc, 'magic'), /未知调拨策略/);
});
