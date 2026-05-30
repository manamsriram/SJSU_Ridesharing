// Vercel serverless proxy — forwards /api/* to API_GATEWAY_URL/api/*
// vercel.json rewrites don't support $ENV_VAR substitution, so we use a function.
export default async function handler(req, res) {
  const gatewayUrl = process.env.API_GATEWAY_URL;

  if (!gatewayUrl) {
    return res.status(503).json({ status: 'error', message: 'Gateway not configured' });
  }

  const upstreamUrl = `${gatewayUrl}${req.url}`;

  const headers = { ...req.headers };
  delete headers['host'];

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: body?.length ? body : undefined,
  });

  const responseBody = await upstream.arrayBuffer();

  upstream.headers.forEach((value, key) => {
    if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });

  res.status(upstream.status).send(Buffer.from(responseBody));
}
