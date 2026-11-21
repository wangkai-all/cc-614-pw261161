// 服务入口：node server.js 启动；读取环境变量 PORT（默认 3000），仅绑定 127.0.0.1。
import { createServer } from 'node:http';
import { handleRequest } from './lib/http-handler.js';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const HOST = '127.0.0.1';

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`非法 PORT: ${process.env.PORT}`);
  process.exit(1);
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('未捕获的处理异常:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '服务器内部错误' }));
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`周转箱调拨仿真服务已启动: http://${HOST}:${PORT}`);
  console.log('按 Ctrl+C 停止');
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
