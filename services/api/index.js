const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function handler(req, res) {
  const target = process.env.API_GATEWAY_URL;
  if (!target) {
    res.statusCode = 503;
    res.end(JSON.stringify({ status: 'error', message: 'Gateway not configured' }));
    return;
  }
  createProxyMiddleware({ target, changeOrigin: true })(req, res, (err) => {
    if (err) {
      res.statusCode = 502;
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
  });
};
