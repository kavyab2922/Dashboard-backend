const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const logger = require('./logger');

let s3Client = null;

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

module.exports = {
  s3Client,
  bucketName: process.env.AWS_BUCKET_NAME || 'simplify3x-hcm-data-dev',
  uploadToS3: async (fileBuffer, fileName, mimeType) => {
    if (!s3Client) {
      throw new Error('AWS S3 is not configured');
    }
    const key = `uploads/${Date.now()}_${fileName}`;
    const command = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME || 'simplify3x-hcm-data-dev',
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
    });
    await s3Client.send(command);
    const region = process.env.AWS_REGION || 'ap-south-1';
    const bucket = process.env.AWS_BUCKET_NAME;
    return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  },
};
