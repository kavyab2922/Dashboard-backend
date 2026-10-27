const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const bucketName = process.env.AWS_BUCKET_NAME || 'simplify3x-hcm-data-dev';
const region = process.env.AWS_REGION || 'ap-south-1';

const s3Client = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  ? new S3Client({
      region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    })
  : null;

function safeFileName(fileName) {
  return String(fileName || 'upload').replace(/[^a-zA-Z0-9._-]/g, '-');
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

  return {
    key,
    url: `https://${bucketName}.s3.${region}.amazonaws.com/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
  };
}

module.exports = { s3Client, bucketName, uploadToS3 };
