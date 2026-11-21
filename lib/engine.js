// 事件引擎：按时间戳重放入箱/租借/归还/调拨到达事件。
//
// 因果性保证（题眼）：
//   策略 decide() 拿到的快照仅包含“当前时刻 now”的库存、积压、在途与车辆状态，
//   引擎从不把后续事件传入策略，因此任何策略都无法用未来的归还为当前缺箱补箱。
//
// 同一时刻的处理次序：1) 调拨车辆到达 → 2) 真实业务事件（入箱/租借/归还）
//   → 3) 策略评估并产生调拨申请 → 4) 单台车辆按争用裁决发车。

import { validateScenario } from './validation.js';
import { getStrategy } from './strategies.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function distanceKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function runSimulation(inputScenario, strategyId) {
  const scenario = clone(inputScenario);
  validateScenario(scenario);
  const strategy = getStrategy(strategyId);

  const kmPerMin = scenario.policy.kmPerMin;
  const distanceMap = new Map(
    Object.entries(scenario.distances).map(([key, km]) => {
      const [a, b] = key.split('-');
      return [distanceKey(a, b), km];
    }),
  );
  const getDistance = (a, b) => {
    if (a === b) return 0;
    return distanceMap.get(distanceKey(a, b));
  };

  // ---- 仓点状态 ----
  const warehouseIds = scenario.warehouses.map((w) => w.id);
  const confOf = new Map(scenario.warehouses.map((w) => [w.id, w]));
  const stock = new Map(warehouseIds.map((id) => [id, confOf.get(id).initialStock]));
  const backlog = new Map(warehouseIds.map((id) => [id, 0]));
  const incoming = new Map(warehouseIds.map((id) => [id, 0]));

  // ---- 车辆（全局唯一）----
  const vehicle = {
    location: scenario.vehicle.startAt,
    capacity: scenario.vehicle.capacity,
    busy: false,
    freeAt: 0,
    currentTripId: null,
  };

  // 每个仓点最多挂一个待处理申请；车辆忙时新申请在此排队
  const pendingRequests = new Map();
  // 调拨到达队列（按 arrivesAt 非降维护）
  const arrivals = [];
  const trips = [];
  const contentionLog = [];
  const shortageEpisodes = [];
  const openEpisodes = new Map();

  const realEvents = clone(scenario.events);
  const eventTimeline = realEvents.map((ev) => ({ ...ev, status: 'pending' }));
  let eventIdx = 0;
  let now = realEvents[0].time;

  function refreshEpisode(warehouseId) {
    const b = backlog.get(warehouseId);
    const open = openEpisodes.get(warehouseId);
    if (b > 0 && !open) {
      openEpisodes.set(warehouseId, {
        warehouse: warehouseId,
        start: now,
        peakBacklog: b,
      });
    } else if (b > 0 && open) {
      open.peakBacklog = Math.max(open.peakBacklog, b);
    } else if (b === 0 && open) {
      open.end = now;
      open.durationMinutes = now - open.start;
      shortageEpisodes.push(open);
      openEpisodes.delete(warehouseId);
    }
  }

  // 任何库存增加（入箱/归还/调拨到达）都先按 FIFO 清偿租借积压
  function addStock(warehouseId, quantity) {
    let remain = quantity;
    const b = backlog.get(warehouseId);
    let backlogCleared = 0;
    if (b > 0) {
      backlogCleared = Math.min(b, remain);
      backlog.set(warehouseId, b - backlogCleared);
      remain -= backlogCleared;
    }
    stock.set(warehouseId, stock.get(warehouseId) + remain);
    refreshEpisode(warehouseId);
    return backlogCleared;
  }

  function applyRental(ev, timelineEntry) {
    const warehouseId = ev.warehouse;
    const available = stock.get(warehouseId);
    const served = Math.min(available, ev.quantity);
    stock.set(warehouseId, available - served);
    const unserved = ev.quantity - served;
    if (unserved > 0) {
      backlog.set(warehouseId, backlog.get(warehouseId) + unserved);
    }
    refreshEpisode(warehouseId);
    Object.assign(timelineEntry, {
      status: 'processed',
      servedQuantity: served,
      unservedQuantity: unserved,
      stockAfter: stock.get(warehouseId),
      backlogAfter: backlog.get(warehouseId),
    });
  }

  function applyArrival(trip) {
    vehicle.busy = false;
    vehicle.freeAt = now;
    vehicle.location = trip.destination;
    vehicle.currentTripId = null;
    incoming.set(trip.destination, incoming.get(trip.destination) - trip.quantity);
    const backlogCleared = addStock(trip.destination, trip.quantity);
    trip.arrivedAt = now;
    trip.backlogClearedOnArrival = backlogCleared;
    trip.stockAfterArrival = stock.get(trip.destination);
  }

  function buildSnapshot(warehouseId) {
    const conf = confOf.get(warehouseId);
    return {
      warehouseId,
      time: now,
      stock: stock.get(warehouseId),
      backlog: backlog.get(warehouseId),
      incoming: incoming.get(warehouseId),
      lowWatermark: conf.lowWatermark,
      orderUpTo: conf.orderUpTo,
      batchThreshold: conf.batchThreshold,
      vehicle: {
        location: vehicle.location,
        busy: vehicle.busy,
        freeAt: vehicle.freeAt,
        capacity: vehicle.capacity,
      },
    };
  }

  // 选捐箱仓：自身无积压、划出箱量后仍不跌破自身低水位；取最近者，同距取 id 较小者
  function pickDonor(destinationId, requestedQty) {
    let best = null;
    for (const donorId of warehouseIds) {
      if (donorId === destinationId) continue;
      if (backlog.get(donorId) > 0) continue;
      const conf = confOf.get(donorId);
      const spare = stock.get(donorId) - conf.lowWatermark;
      if (spare <= 0) continue;
      const distance = getDistance(donorId, destinationId);
      if (distance === undefined) continue;
      const candidate = { donorId, distance, spare };
      if (
        !best ||
        candidate.distance < best.distance ||
        (candidate.distance === best.distance && candidate.donorId < best.donorId)
      ) {
        best = candidate;
      }
    }
    return best;
  }

  function dispatchLoop() {
    // 车辆忙或无申请时直接结束；循环处理“一趟车发完后队列里仍有申请”的情况
    while (!vehicle.busy && pendingRequests.size > 0) {
      // 争用裁决：当前积压量大者优先 → 申请时间早者优先 → 仓 id 字典序
      const ranked = [...pendingRequests.values()].sort((x, y) => {
        const bx = backlog.get(x.warehouse);
        const by = backlog.get(y.warehouse);
        if (by !== bx) return by - bx;
        if (x.requestedAt !== y.requestedAt) return x.requestedAt - y.requestedAt;
        return x.warehouse < y.warehouse ? -1 : 1;
      });

      let dispatched = false;
      for (const req of ranked) {
        const donor = pickDonor(req.warehouse, req.requestedQty);
        if (!donor) continue; // 该申请暂时无箱源，尝试下一个申请者

        const quantity = Math.min(
          req.requestedQty,
          vehicle.capacity,
          donor.spare,
        );
        if (quantity <= 0) continue;

        const contenders = ranked.filter((r) => r.warehouse !== req.warehouse)
          .map((r) => r.warehouse);
        if (ranked.length > 1) {
          contentionLog.push({
            time: now,
            winner: req.warehouse,
            losers: contenders,
            winnerBacklog: backlog.get(req.warehouse),
            rule: '积压量大优先 → 申请时间早优先 → 仓 id 字典序',
          });
        }

        const emptyLegKm = vehicle.location === donor.donorId
          ? 0
          : getDistance(vehicle.location, donor.donorId);
        const loadLegKm = donor.distance;
        const trip = {
          id: `T${trips.length + 1}`,
          strategyId,
          dispatchedAt: now,
          donor: donor.donorId,
          destination: req.warehouse,
          quantity,
          capacity: vehicle.capacity,
          emptyLegKm,
          loadLegKm,
          distanceKm: emptyLegKm + loadLegKm,
          travelMinutes: (emptyLegKm + loadLegKm) / kmPerMin,
          arrivesAt: now + (emptyLegKm + loadLegKm) / kmPerMin,
          contended: ranked.length > 1,
          waitingWarehouses: contenders,
          reason: req.reason,
        };
        trips.push(trip);

        stock.set(donor.donorId, stock.get(donor.donorId) - quantity);
        incoming.set(req.warehouse, incoming.get(req.warehouse) + quantity);
        vehicle.location = donor.donorId; // 空驶到捐箱仓后再重载出发
        vehicle.busy = true;
        vehicle.freeAt = trip.arrivesAt;
        vehicle.currentTripId = trip.id;
        pendingRequests.delete(req.warehouse);

        // 保持到达队列有序
        let insertAt = arrivals.findIndex((a) => a.arrivesAt > trip.arrivesAt);
        if (insertAt === -1) insertAt = arrivals.length;
        arrivals.splice(insertAt, 0, trip);

        dispatched = true;
        break; // 单车次：一次只能发一趟
      }
      if (!dispatched) break; // 所有申请都找不到箱源，等待未来事件
    }
  }

  // ---- 主重放循环 ----
  while (
    eventIdx < realEvents.length ||
    arrivals.length > 0 ||
    pendingRequests.size > 0
  ) {
    const nextReal = eventIdx < realEvents.length ? realEvents[eventIdx].time : Infinity;
    const nextArrival = arrivals.length > 0 ? arrivals[0].arrivesAt : Infinity;
    now = Math.min(nextReal, nextArrival);
    if (!Number.isFinite(now)) break;

    // 1) 调拨到达
    while (arrivals.length > 0 && arrivals[0].arrivesAt <= now) {
      applyArrival(arrivals.shift());
    }

    // 2) 同一时刻的真实业务事件（保持数组顺序，A 先于 B）
    while (eventIdx < realEvents.length && realEvents[eventIdx].time === now) {
      const ev = realEvents[eventIdx];
      const timelineEntry = eventTimeline[eventIdx];
      eventIdx += 1;
      if (ev.type === 'rental') {
        applyRental(ev, timelineEntry);
      } else {
        const backlogCleared = addStock(ev.warehouse, ev.quantity);
        Object.assign(timelineEntry, {
          status: 'processed',
          addedQuantity: ev.quantity,
          backlogCleared,
          stockAfter: stock.get(ev.warehouse),
          backlogAfter: backlog.get(ev.warehouse),
        });
      }
    }

    // 3) 策略评估：纯箱源仓不承接需求、不产生补箱申请；其余仓点若尚未挂申请则评估
    for (const warehouseId of warehouseIds) {
      if (confOf.get(warehouseId).sourceOnly) continue;
      if (pendingRequests.has(warehouseId)) continue;
      const snapshot = buildSnapshot(warehouseId);
      const need = strategy.decide(snapshot);
      if (need !== null && need !== undefined && need > 0) {
        pendingRequests.set(warehouseId, {
          warehouse: warehouseId,
          requestedAt: now,
          requestedQty: need,
          reason: strategy.id === 'immediate'
            ? '有效库存跌破低水位或存在租借积压，立即补到目标水位'
            : '有效库存跌破批量阈值，凑大批量一次性补到目标水位',
        });
      }
    }

    // 4) 争用裁决并发车
    dispatchLoop();

    // 无事件、无在途、车辆空闲却仍有申请：箱源永远不足，终止避免死循环
    if (eventIdx >= realEvents.length && arrivals.length === 0 && !vehicle.busy) {
      break;
    }
  }

  // 收尾：未结清的缺箱时段在 horizon（缺省取最后时刻）截断
  const closeTime = Number.isFinite(scenario.horizon)
    ? Math.max(scenario.horizon, now)
    : now;
  for (const [warehouseId, episode] of openEpisodes.entries()) {
    episode.end = closeTime;
    episode.durationMinutes = closeTime - episode.start;
    episode.closedAtHorizon = true;
    shortageEpisodes.push(episode);
    openEpisodes.delete(warehouseId);
  }

  const shortageByWarehouse = Object.fromEntries(
    warehouseIds.map((id) => [id, 0]),
  );
  for (const ep of shortageEpisodes) {
    shortageByWarehouse[ep.warehouse] += ep.durationMinutes;
  }

  const emptyMileageKm = trips.reduce((sum, t) => sum + t.emptyLegKm, 0);
  const loadedMileageKm = trips.reduce((sum, t) => sum + t.loadLegKm, 0);

  return {
    strategyId,
    strategyName: strategy.name,
    scenarioName: scenario.name,
    variant: scenario.variant ?? null,
    horizon: closeTime,
    kpi: {
      totalShortageMinutes: shortageEpisodes.reduce((s, e) => s + e.durationMinutes, 0),
      shortageMinutesByWarehouse: shortageByWarehouse,
      emptyMileageKm,
      loadedMileageKm,
      totalMileageKm: emptyMileageKm + loadedMileageKm,
      tripsCount: trips.length,
      contentionCount: contentionLog.length,
      unmetRequests: pendingRequests.size,
    },
    shortageEpisodes,
    trips,
    contentionLog,
    eventTimeline,
    pendingRequestsAtEnd: [...pendingRequests.values()],
    finalState: {
      stock: Object.fromEntries(stock),
      backlog: Object.fromEntries(backlog),
      incoming: Object.fromEntries(incoming),
      vehicleLocation: vehicle.location,
    },
  };
}
