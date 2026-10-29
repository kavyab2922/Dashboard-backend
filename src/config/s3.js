const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { Agent: HttpsAgent } = require('https');

const bucketName = process.env.AWS_BUCKET_NAME || '';
const region = process.env.AWS_REGION || '';
const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
const sessionToken = process.env.AWS_SESSION_TOKEN || undefined;

const requestTimeout = Number(process.env.AWS_S3_TIMEOUT) || 60_000;
const connectionTimeout = Number(process.env.AWS_S3_CONNECTION_TIMEOUT) || 10_000;
const httpsAgent = new HttpsAgent({
  keepAlive: process.env.AWS_S3_KEEP_ALIVE === 'true',
  keepAliveMsecs: Number(process.env.AWS_S3_KEEP_ALIVE_MSECS) || 1_000,
  maxSockets: Number(process.env.AWS_S3_MAX_SOCKETS) || 50,
  maxFreeSockets: Number(process.env.AWS_S3_MAX_FREE_SOCKETS) || 10,
  timeout: Number(process.env.AWS_S3_FREE_SOCKET_TIMEOUT) || 30_000,
});

if (process.env.NODE_ENV === 'development') {
  const mask = (value) => value ? `${value.slice(0, 4)}...${value.slice(-4)}` : '<missing>';
  console.log('[AWS S3 config]', {
    bucket: bucketName || '<missing>',
    region: region || '<missing>',
    accessKeyId: mask(accessKeyId),
    secretAccessKey: secretAccessKey ? `<configured, length=${secretAccessKey.length}>` : '<missing>',
    sessionToken: sessionToken ? '<configured>' : '<not configured>',
  });
  if (secretAccessKey && secretAccessKey.length !== 40) {
    console.warn(`[AWS S3 config] WARNING: AWS_SECRET_ACCESS_KEY is ${secretAccessKey.length} characters long. Standard AWS secret access keys are always exactly 40 characters. AWS will reject requests with SignatureDoesNotMatch.`);
  }
}

const s3Client = accessKeyId && secretAccessKey && region && bucketName
  ? new S3Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      },
      maxAttempts: Number(process.env.AWS_S3_MAX_ATTEMPTS) || 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout,
        requestTimeout,
        httpsAgent,
      }),
    })
  : null;

function safeFileName(fileName) {
  return String(fileName || 'upload').replace(/[^a-zA-Z0-9._-]/g, '-');
}

async function getObjectStream(key) {
  if (!s3Client) throw new Error('AWS S3 is not configured');

  return await s3Client.send(new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  }));
}

async function getS3ReadUrl(asset) {
  if (!asset || !s3Client) return asset;

  let key = null;
  try {
    if (asset.startsWith('uploads/')) {
      key = asset;
    } else {
      const parsed = new URL(asset);
      const expectedHost = `${bucketName}.s3.${region}.amazonaws.com`;
      if (parsed.hostname === expectedHost) {
        key = decodeURIComponent(parsed.pathname.slice(1));
      }
    }
  } catch {
    return asset;
  }

  if (!key) return asset;

  try {
    return await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: bucketName, Key: key }),
      { expiresIn: 604800 },
    );
  } catch {
    return asset;
  }
}

async function uploadToS3(fileBuffer, fileName, mimeType) {
  if (!s3Client) throw new Error('AWS S3 is not configured');

  const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}-${safeFileName(fileName)}`;
  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: fileBuffer,
    ContentType: mimeType,
  }));

  return { key, url: `https://${bucketName}.s3.${region}.amazonaws.com/${encodeURIComponent(key).replace(/%2F/g, '/')}` };
}

module.exports = { s3Client, bucketName, region, uploadToS3, getObjectStream, getS3ReadUrl };
