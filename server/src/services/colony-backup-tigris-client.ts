/**
 * Sprint A.5 · PR1 — Thin Tigris (S3-compatible) upload helper.
 *
 * Isolated in its own module so `colony-backup.ts` can be loaded
 * without pulling `@aws-sdk/client-s3` into the import graph in
 * unit tests. The S3 client only constructs at first call.
 */

import type { Readable } from "node:stream";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export interface UploadToTigrisInput {
	bucket: string;
	key: string;
	body: Readable;
	contentLength: number;
	contentType: string;
	region: string;
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export async function uploadToTigris(input: UploadToTigrisInput): Promise<void> {
	const client = new S3Client({
		region: input.region,
		endpoint: input.endpoint,
		forcePathStyle: true,
		credentials: {
			accessKeyId: input.accessKeyId,
			secretAccessKey: input.secretAccessKey,
		},
	});
	try {
		await client.send(
			new PutObjectCommand({
				Bucket: input.bucket,
				Key: input.key,
				Body: input.body,
				ContentType: input.contentType,
				ContentLength: input.contentLength,
			}),
		);
	} finally {
		client.destroy();
	}
}
