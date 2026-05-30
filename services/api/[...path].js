const http = require('http');
const https = require('https');

module.exports = async function handler(req, res) {
  const gatewayUrl = process.env.API_GATEWAY_URL;

  if (!gatewayUrl) {
    res.status(503).json({ status: 'error', message: 'Gateway not configured' });
    return;
  }

  const target = new URL(req.url, gatewayUrl);
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const options = {
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: target.pathname + target.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: target.hostname,
      'content-length': body.length,
    },
  };

  await new Promise((resolve, reject) => {
    const proxy = transport.request(options, (upstream) => {
      res.status(upstream.statusCode);
      Object.entries(upstream.headers).forEach(([k, v]) => {
        if (!['transfer-encoding', 'connection'].includes(k.toLowerCase())) {
          res.setHeader(k, v);
        }
      });
      upstream.pipe(res);
      upstream.on('end', resolve);
    });
    proxy.on('error', reject);
    if (body.length) proxy.write(body);
    proxy.end();
  });
};
