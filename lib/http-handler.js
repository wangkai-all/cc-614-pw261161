// HTTP 请求处理：静态页面 + JSON API。仅使用 Node.js 内置模块。
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { runComparison, runLateReturnComparison, runTimeline } from './compare.js';
import { buildSampleScenario } from './scenario.js';
import { validateScenario } from './validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw Object.assign(new Error('请求体超过 1MB 限制'), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    throw Object.assign(new Error('请求体为空，需要场景 JSON'), { status: 400 });
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: '禁止访问该路径' });
    return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'content-length': content.length,
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: `静态资源不存在: ${pathname}` });
  }
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const { pathname, searchParams } = url;

  try {
    if (pathname === '/api/sample') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: `不支持的方法: ${req.method}` });
      const variant = searchParams.get('variant') ?? 'baseline';
      return sendJson(res, 200, buildSampleScenario(variant));
    }

    if (pathname === '/api/compare') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: `不支持的方法: ${req.method}` });
      const scenario = await readJsonBody(req);
      validateScenario(scenario); // 先显式校验，异常由 catch 转 400
      return sendJson(res, 200, runComparison(scenario));
    }

    if (pathname === '/api/late-return') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: `不支持的方法: ${req.method}` });
      return sendJson(res, 200, runLateReturnComparison());
    }

    if (pathname === '/api/timeline') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: `不支持的方法: ${req.method}` });
      const variant = searchParams.get('variant') ?? 'baseline';
      return sendJson(res, 200, runTimeline(buildSampleScenario(variant)));
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: `未知接口: ${req.method} ${pathname}` });
    }

    if (req.method === 'GET') {
      return await serveStatic(req, res, pathname);
    }

    return sendJson(res, 405, { error: `不支持的方法: ${req.method}` });
  } catch (err) {
    const status = err.status ?? 400;
    return sendJson(res, status, {
      error: err.message,
      validationErrors: err.validationErrors ?? undefined,
    });
  }
}
