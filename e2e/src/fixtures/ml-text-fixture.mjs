import { createServer } from 'node:http';

const vector = `[${[1, ...Array(767).fill(0)].join(',')}]`;

createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/ping') {
    response.writeHead(200).end('pong');
    return;
  }
  if (request.method === 'GET' && request.url === '/capabilities') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ workloads: ['clip'] }));
    return;
  }
  if (request.method === 'POST' && request.url === '/predict') {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 4096) {
        response.writeHead(413).end();
        return;
      }
    }
    if (body.includes('fl144-threshold-fixture') && body.includes('"textual"')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ clip: vector }));
      return;
    }
  }
  response.writeHead(404).end();
}).listen(3003, '0.0.0.0');
