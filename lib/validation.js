// 场景数据校验。校验失败统一抛 Error（含中文原因），由 HTTP 层转成 400 响应。
// 覆盖题中的异常结果：非法事件类型、负库存/负参数、时间倒流、未知仓点引用、
// 自环距离、缺车辆或缺策略配置等。

const EVENT_TYPES = ['intake', 'rental', 'return'];

function isNonNegInt(value, label, errors) {
  if (!Number.isInteger(value) || value < 0) {
    errors.push(`${label} 必须是非负整数，收到 ${JSON.stringify(value)}`);
    return false;
  }
  return true;
}

export function validateScenario(scenario) {
  const errors = [];
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    throw new Error('场景必须是一个对象');
  }

  const { name, warehouses, distances, vehicle, policy, events } = scenario;

  if (typeof name !== 'string' || !name.trim()) {
    errors.push('name 必须是非空字符串');
  }

  // ---- 仓点 ----
  if (!Array.isArray(warehouses) || warehouses.length < 2) {
    errors.push('warehouses 至少需要两个仓点');
  } else {
    const ids = new Set();
    for (const w of warehouses) {
      if (!w || typeof w !== 'object') {
        errors.push('warehouses 元素必须是对象');
        continue;
      }
      if (typeof w.id !== 'string' || !w.id.trim()) {
        errors.push('仓点 id 必须是非空字符串');
        continue;
      }
      if (ids.has(w.id)) {
        errors.push(`仓点 id 重复: ${w.id}`);
      }
      ids.add(w.id);
      if (w.sourceOnly !== undefined && typeof w.sourceOnly !== 'boolean') {
        errors.push(`仓点 ${w.id} 的 sourceOnly 必须是布尔值`);
      }
      isNonNegInt(w.initialStock, `仓点 ${w.id} 的 initialStock`, errors);
      if (!Number.isFinite(w.lowWatermark) || w.lowWatermark < 0) {
        errors.push(`仓点 ${w.id} 的 lowWatermark 必须是非负数`);
      }
      if (!Number.isInteger(w.orderUpTo) || w.orderUpTo <= 0) {
        errors.push(`仓点 ${w.id} 的 orderUpTo 必须是正整数`);
      }
      if (!Number.isInteger(w.batchThreshold) || w.batchThreshold < 0) {
        errors.push(`仓点 ${w.id} 的 batchThreshold 必须是非负整数`);
      }
      if (Number.isInteger(w.orderUpTo) &&
          Number.isInteger(w.batchThreshold) &&
          w.batchThreshold > w.orderUpTo) {
        errors.push(`仓点 ${w.id} 的 batchThreshold 不能高于 orderUpTo`);
      }
    }
  }

  const knownIds = new Set(Array.isArray(warehouses)
    ? warehouses.filter((w) => w && typeof w.id === 'string').map((w) => w.id)
    : []);

  // ---- 距离矩阵 ----
  if (!distances || typeof distances !== 'object' || Array.isArray(distances)) {
    errors.push('distances 必须是对象（"A-B": 公里数）');
  } else {
    for (const [key, km] of Object.entries(distances)) {
      const parts = key.split('-');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        errors.push(`距离键格式非法: ${key}，应为 "A-B"`);
        continue;
      }
      const [a, b] = parts;
      if (!knownIds.has(a) || !knownIds.has(b)) {
        errors.push(`距离 ${key} 引用了未知仓点`);
      } else if (a === b) {
        errors.push(`距离 ${key} 是自环，仓点到自身的距离不允许配置`);
      }
      if (!Number.isFinite(km) || km <= 0) {
        errors.push(`距离 ${key} 必须是正数，收到 ${JSON.stringify(km)}`);
      }
    }
    // 任意两个仓点之间都要可达，否则调拨可能无法完成
    const ids = [...knownIds];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = `${ids[i]}-${ids[j]}`;
        const reverse = `${ids[j]}-${ids[i]}`;
        if (!(key in distances) && !(reverse in distances)) {
          errors.push(`仓点 ${ids[i]} 与 ${ids[j]} 之间缺少距离配置`);
        }
      }
    }
  }

  // ---- 车辆 ----
  if (!vehicle || typeof vehicle !== 'object') {
    errors.push('vehicle 必须是对象');
  } else {
    if (!knownIds.has(vehicle.startAt)) {
      errors.push(`vehicle.startAt 引用了未知仓点: ${JSON.stringify(vehicle.startAt)}`);
    }
    isNonNegInt(vehicle.capacity, 'vehicle.capacity', errors);
    if (vehicle.capacity === 0) {
      errors.push('vehicle.capacity 必须大于 0，否则任何调拨都无法执行');
    }
  }

  // ---- 策略参数（速度等） ----
  if (!policy || typeof policy !== 'object') {
    errors.push('policy 必须是对象');
  } else if (!Number.isFinite(policy.kmPerMin) || policy.kmPerMin <= 0) {
    errors.push('policy.kmPerMin 必须是正数（每分钟行驶公里数）');
  }

  // ---- 事件 ----
  if (!Array.isArray(events) || events.length === 0) {
    errors.push('events 必须是非空数组');
  } else {
    let lastTime = -Infinity;
    events.forEach((ev, idx) => {
      const where = `events[${idx}]`;
      if (!ev || typeof ev !== 'object') {
        errors.push(`${where} 必须是对象`);
        return;
      }
      if (!EVENT_TYPES.includes(ev.type)) {
        errors.push(`${where}.type 非法: ${JSON.stringify(ev.type)}，允许 ${EVENT_TYPES.join('/')}`);
      }
      if (!knownIds.has(ev.warehouse)) {
        errors.push(`${where}.warehouse 引用了未知仓点: ${JSON.stringify(ev.warehouse)}`);
      }
      if (!Number.isInteger(ev.time) || ev.time < 0) {
        errors.push(`${where}.time 必须是非负整数`);
      } else if (ev.time < lastTime) {
        errors.push(`${where}.time 时间倒流：${ev.time} 早于前一事件 ${lastTime}`);
      } else {
        lastTime = ev.time;
      }
      if (!Number.isInteger(ev.quantity) || ev.quantity <= 0) {
        errors.push(`${where}.quantity 必须是正整数`);
      }
    });
  }

  if (errors.length > 0) {
    const err = new Error(`场景校验失败：\n  - ${errors.join('\n  - ')}`);
    err.validationErrors = errors;
    throw err;
  }
  return true;
}
