const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

function getBlobClient() {
  return BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

app.http('sessionsPreflight', {
  methods: ['OPTIONS'],
  authLevel: 'anonymous',
  route: 'sessions',
  handler: async () => ({ status: 204, headers: CORS_HEADERS })
});

// POST /api/sessions — save session blob + update device index
// GET  /api/sessions?deviceId=xxx — return device index (summary list)
app.http('sessions', {
  methods: ['POST', 'GET'],
  authLevel: 'anonymous',
  route: 'sessions',
  handler: async (request) => {
    try {
    const blobService = getBlobClient();
    const container = blobService.getContainerClient('sessions');
    await container.createIfNotExists();

    if (request.method === 'POST') {
      const session = await request.json();
      if (!session?.id || !session?.deviceId) {
        return { status: 400, headers: CORS_HEADERS, jsonBody: { error: 'id and deviceId required' } };
      }

      // Save full session blob: {deviceId}/{id}.json
      const sessionBlob = container.getBlockBlobClient(`${session.deviceId}/${session.id}.json`);
      const body = JSON.stringify(session);
      await sessionBlob.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: 'application/json' }
      });

      // Update index blob: {deviceId}/index.json
      const indexBlob = container.getBlockBlobClient(`${session.deviceId}/index.json`);
      let index = [];
      try {
        const download = await indexBlob.download();
        const text = await streamToString(download.readableStreamBody);
        index = JSON.parse(text);
      } catch { /* index doesn't exist yet */ }

      const entry = {
        id: session.id,
        sessionStart: session.sessionStart,
        sessionEnd: session.sessionEnd,
        totalMs: session.totalMs,
        categorySummary: session.categorySummary,
        createdAt: session.createdAt
      };
      index.unshift(entry); // newest first
      const indexBody = JSON.stringify(index);
      await indexBlob.upload(indexBody, Buffer.byteLength(indexBody), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        overwrite: true
      });

      return { status: 201, headers: CORS_HEADERS, jsonBody: { id: session.id } };
    }

    // GET — return index for deviceId
    const deviceId = request.query.get('deviceId');
    if (!deviceId) return { status: 400, headers: CORS_HEADERS, jsonBody: { error: 'deviceId required' } };

    const indexBlob = container.getBlockBlobClient(`${deviceId}/index.json`);
    try {
      const download = await indexBlob.download();
      const text = await streamToString(download.readableStreamBody);
      return { headers: CORS_HEADERS, jsonBody: JSON.parse(text) };
    } catch {
      return { headers: CORS_HEADERS, jsonBody: [] };
    }
    } catch (err) {
      return { status: 500, headers: CORS_HEADERS, jsonBody: { error: err.message } };
    }
  }
});

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
