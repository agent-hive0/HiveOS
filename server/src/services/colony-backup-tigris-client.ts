/**
 * Sprint A.5 · PR1+PR2 — Thin Tigris (S3-compatible) upload/download
 * helpers.
 *
 * Isolated in its own module so `colony-backup.ts` and
 * `colony-restore.ts` can be loaded without pulling
 * `@aws-sdk/client-s3` into the import graph in unit tests. The S3
 * client only constructs at first call.
 */

import type { Readable } from "node:stream";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

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

export interface DownloadFromTigrisInput {
	bucket: string;
	key: string;
	region: string;
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
}

/**
 * Downloads a Tigris object into memory. Backups are bounded by the
 * volume floor (≤75 GB plaintext, gzipped + encrypted typically much
 * smaller) and restore is a rare operator action, so the simpler
 * full-buffer path is the right call here.
 */
export async function downloadFromTigris(
	input: DownloadFromTigrisInput,
): Promise<Buffer> {
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
		const res = await client.send(
			new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
		);
		const body = res.Body as Readable | undefined;
		if (!body) {
			throw new Error(`Tigris GET ${input.bucket}/${input.key} returned no body`);
		}
		const chunks: Buffer[] = [];
		for await (const chunk of body) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	} finally {
		client.destroy();
	}
}
