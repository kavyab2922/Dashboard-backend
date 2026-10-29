# HR Orbit AWS S3 Upload Investigation

## Error

```text
SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.
```

## Root Cause

The backend reaches AWS S3, but AWS rejects the signed request with HTTP 403 `SignatureDoesNotMatch`.

The application code and environment loading were investigated. The failure is caused by the AWS credential pair being rejected during signature validation. DevOps must verify that the access key and secret key belong together, are active, and belong to the AWS account containing the configured bucket.

## Verified Code

### Environment loading

`src/index.js` loads the backend environment file:

```js
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
```

The required variables are:

```env
AWS_BUCKET_NAME=<bucket-name>
AWS_REGION=<aws-region>
AWS_ACCESS_KEY_ID=<access-key-id>
AWS_SECRET_ACCESS_KEY=<secret-access-key>
```

Real credentials must never be committed, logged, or included in this report.

### S3 client

`src/config/s3.js` contains the only S3 client:

```js
const s3Client = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
```

The upload uses `PutObjectCommand` and stores files under the `uploads/` prefix.

No conflicting S3 clients, custom endpoints, presigned URL changes, or alternate S3 operations were found in the backend source.

## Safe Checks Completed

- All four AWS environment variables were present.
- No leading, trailing, or internal whitespace was detected.
- The runtime values matched the values loaded from the backend `.env` file.
- The configured bucket region was verified as `ap-south-1`.
- The local system clock was checked.
- S3 rejected the request with `SignatureDoesNotMatch`, confirming that the failure occurs during AWS request authentication.
- Backend syntax checks passed.
- Existing backend tests passed: 19 passed, 0 failed.

## Files Reviewed

- `src/index.js`
- `src/config/s3.js`
- `src/controllers/uploadController.js`
- `src/routes/api.js`
- `src/middleware/upload.js`
- `src/middleware/errorHandler.js`
- `.env`

## Required DevOps Verification

Verify that the credentials used by the backend:

1. Belong to the same IAM user or role.
2. Are active and not deleted or disabled.
3. Belong to the AWS account containing the bucket.
4. Are standard AWS credentials, not credentials for another S3-compatible service.
5. Have permission to upload to:

```text
arn:aws:s3:::simplify3x-hcm-data-dev/uploads/*
```

A minimum permission commonly required for this upload is:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::simplify3x-hcm-data-dev/uploads/*"
    }
  ]
}
```

Do not add public bucket access as a workaround.

## Manual Steps

1. Ask DevOps to verify the access key and matching secret key in AWS IAM.
2. If necessary, update the backend environment file using placeholders such as:

```env
AWS_BUCKET_NAME=<bucket-name>
AWS_REGION=<aws-region>
AWS_ACCESS_KEY_ID=<valid-access-key>
AWS_SECRET_ACCESS_KEY=<matching-secret-key>
```

3. Stop and restart the backend after changing environment values.
4. Retry `POST /api/upload`.
5. Confirm that the response contains a successful upload URL and that the profile record stores the URL.
6. Rotate any credentials that were exposed outside the protected environment.

## Validation Status

The backend upload route and S3 client configuration are structurally correct. Local tests pass, but the actual S3 upload remains blocked until DevOps verifies or replaces the AWS credential pair and permissions.
