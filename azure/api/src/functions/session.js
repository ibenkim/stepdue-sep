const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

function getBlobClient() {
  return BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

app.http('sessionByIdPreflight', {
  methods: ['OPTIONS'],
  authLevel: 'anonymous',
  route: 'sessions/{deviceId}/{id}',
  handler: async () => ({ status: 204, headers: CORS_HEADERS })
});

// GET /api/sessions/{deviceId}/{id} — fetch one full session
app.http('sessionById', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'sessions/{deviceId}/{id}',
  handler: async (request) => {
    const { deviceId, id } = request.params;
    const blobService = getBlobClient();
    const container = blobService.getContainerClient('sessions');
    const blob = container.getBlockBlobClient(`${deviceId}/${id}.json`);

    try {
      const download = await blob.download();
      const chunks = [];
      for await (const chunk of download.readableStreamBody) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      return { headers: CORS_HEADERS, jsonBody: JSON.parse(text) };
    } catch {
      return { status: 404, headers: CORS_HEADERS, jsonBody: { error: 'Session not found' } };
    }
  }
});
