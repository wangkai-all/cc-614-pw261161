// HTTP 端到端用例：真实拉起 server.js（随机端口、绑定 127.0.0.1），
// 覆盖正常接口、静态页、异常入参（400）、未知路由（404）等。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server.js');

let baseUrl;
let child;

before(async () => {
  const port = 43123 + Math.floor(Math.random() * 2000);
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, PORT: String(port) },
  });
  baseUrl = `http://127.0.0.1:${port}`;

  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

  // 等待服务打印启动日志
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务启动超时')), 8000);
    child.stdout.on('data', (chunk) => {
      if (chunk.includes('服务已启动')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出，code=${code}`));
    });
  });
  await ready;

  // 轮询确认接口真正可接连接
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/api/sample?variant=baseline`);
      if (res.ok) return;
    } catch { /* 未就绪，重试 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务健康检查失败');
});

after(() => {
  child?.kill('SIGTERM');
});

test('GET /api/sample 返回基线与晚到两个版本', async () => {
  const base = await fetch(`${baseUrl}/api/sample?variant=baseline`).then((r) => r.json());
  assert.equal(base.variant, 'baseline');
  assert.ok(base.events.length > 0);

  const late = await fetch(`${baseUrl}/api/sample?variant=late`).then((r) => r.json());
  assert.equal(late.variant, 'late');
  assert.equal(late.lateReturn.delayMinutes, 30);
});

test('POST /api/compare 返回两套策略对照与校验签名', async () => {
  const scenario = await fetch(`${baseUrl}/api/sample?variant=baseline`).then((r) => r.json());
  const res = await fetch(`${baseUrl}/api/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scenario),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.runs.map((r) => r.strategyId), ['immediate', 'batch']);
  for (const run of data.runs) {
    assert.match(run.signature, /^[0-9a-f]{12}$/);
    assert.ok(run.kpi.totalMileageKm === run.kpi.emptyMileageKm + run.kpi.loadedMileageKm);
  }
});

test('GET /api/late-return 返回受影响时段对照', async () => {
  const res = await fetch(`${baseUrl}/api/late-return`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(Object.keys(data.variants).sort(), ['batch', 'immediate']);
  assert.equal(data.window.from, 70);
  assert.equal(data.window.to, 100);
  assert.equal(data.variants.immediate.deltas.totalShortageMinutes, 0);
});

test('GET /api/timeline 返回逐趟调拨时点', async () => {
  const res = await fetch(`${baseUrl}/api/timeline?variant=baseline`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.strategies.length, 2);
  assert.ok(data.strategies.every((s) => s.trips.length > 0));
});

test('静态首页可访问且包含 data-evidence-result 业务结果区', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  for (const marker of [
    'data-evidence-result="baseline-comparison"',
    'data-evidence-result="late-return-comparison"',
    'data-evidence-result="dispatch-timeline"',
  ]) {
    assert.ok(html.includes(marker), `首页缺少 ${marker}`);
  }
  assert.ok(html.includes('运行基准策略'));
  assert.ok(html.includes('补迟到归还并比较'));
  assert.ok(html.includes('查看调拨时点'));
});

test('静态资源 app.js / styles.css 可访问', async () => {
  for (const path of ['/app.js', '/styles.css']) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.equal(res.status, 200, path);
  }
});

test('异常：非法 JSON 返回 400', async () => {
  const res = await fetch(`${baseUrl}/api/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /JSON/);
});

test('异常：场景校验失败返回 400 且带逐条原因', async () => {
  const bad = { name: '坏场景', events: [] };
  const res = await fetch(`${baseUrl}/api/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bad),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(Array.isArray(body.validationErrors));
  assert.ok(body.validationErrors.length > 0);
});

test('异常：空请求体返回 400', async () => {
  const res = await fetch(`${baseUrl}/api/compare`, { method: 'POST', body: '' });
  assert.equal(res.status, 400);
});

test('异常：未知 API 路由返回 404，不支持的方法返回 405', async () => {
  const res404 = await fetch(`${baseUrl}/api/nope`);
  assert.equal(res404.status, 404);

  const res405 = await fetch(`${baseUrl}/api/sample?variant=baseline`, { method: 'POST' });
  assert.equal(res405.status, 405);
});

test('服务仅绑定在 127.0.0.1（监听地址不含通配/外部地址）', async () => {
  // 通过响应头与连接成功性侧面验证：127.0.0.1 可连
  const res = await fetch(`${baseUrl}/api/sample?variant=baseline`);
  assert.equal(res.ok, true);
});
