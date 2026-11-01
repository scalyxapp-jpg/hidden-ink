/**
 * Least-significant-bit steganography for PNG covers.
 *
 * A payload is framed, optionally encrypted, and written into the low bit of
 * every colour channel. The pixel values move by at most one step, which no
 * eye can see, so the picture still looks like the picture.
 */

const MAGIC = [0x48, 0x4e, 0x4b, 0x31]; // "HNK1"
const HEADER_BYTES = 41;
const PBKDF2_ITERATIONS = 150_000;
const FLAG_ENCRYPTED = 0b0000_0001;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeUint32(view, offset, value) {
	view[offset] = (value >>> 24) & 0xff;
	view[offset + 1] = (value >>> 16) & 0xff;
	view[offset + 2] = (value >>> 8) & 0xff;
	view[offset + 3] = value & 0xff;
}

function readUint32(bytes, offset) {
	return (
		((bytes[offset] << 24) |
			(bytes[offset + 1] << 16) |
			(bytes[offset + 2] << 8) |
			bytes[offset + 3]) >>>
		0
	);
}

async function deriveKey(passphrase, salt) {
	const base = await crypto.subtle.importKey(
		"raw",
		encoder.encode(passphrase),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt,
			iterations: PBKDF2_ITERATIONS,
			hash: "SHA-256",
		},
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** Bytes available for a message on a canvas of the given size. */
export function capacityBytes(width, height) {
	return Math.max(0, Math.floor((width * height * 3) / 8) - HEADER_BYTES);
}

/**
 * Frame the message into the byte stream that ends up in the pixels.
 * @returns {Promise<{frame: Uint8Array, encrypted: boolean}>}
 */
async function buildFrame(message, passphrase) {
	const plain = encoder.encode(message);
	const header = new Uint8Array(HEADER_BYTES);
	header.set(MAGIC, 0);

	if (!passphrase) {
		writeUint32(header, 33, plain.length);
		writeUint32(header, 37, crc32(plain));
		return { frame: concat(header, plain), encrypted: false };
	}

	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveKey(passphrase, salt);
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			key,
			plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength),
		),
	);

	header[4] = FLAG_ENCRYPTED;
	header.set(salt, 5);
	header.set(iv, 21);
	writeUint32(header, 33, cipher.length);
	writeUint32(header, 37, crc32(cipher));
	return { frame: concat(header, cipher), encrypted: true };
}

function concat(a, b) {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

/**
 * Hide a message inside a picture.
 * @param {ImageBitmap} bitmap
 * @param {{message: string, passphrase?: string}} options
 * @returns {Promise<{blob: Blob, width: number, height: number, capacity: number, used: number, encrypted: boolean}>}
 */
export async function embed(bitmap, { message, passphrase = "" }) {
	const { width, height } = bitmap;
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d", { willReadFrequently: true });
	context.drawImage(bitmap, 0, 0);

	const image = context.getImageData(0, 0, width, height);
	const capacity = capacityBytes(width, height);
	const { frame, encrypted } = await buildFrame(message, passphrase.trim());

	if (frame.length > capacity) {
		throw new Error(
			`This message needs ${frame.length} bytes but the picture only carries ${capacity}.`,
		);
	}

	const pixels = image.data;
	let bitIndex = 0;
	const totalBits = frame.length * 8;

	for (let i = 0; i < pixels.length && bitIndex < totalBits; i += 1) {
		if (i % 4 === 3) continue; // leave alpha alone
		const bit = (frame[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
		pixels[i] = (pixels[i] & 0xfe) | bit;
		bitIndex += 1;
	}

	context.putImageData(image, 0, 0);
	const blob = await canvas.convertToBlob({ type: "image/png" });
	return {
		blob,
		width,
		height,
		capacity,
		used: frame.length,
		encrypted,
	};
}

function readBits(pixels, totalBits) {
	const out = new Uint8Array(Math.ceil(totalBits / 8));
	let bitIndex = 0;
	for (let i = 0; i < pixels.length && bitIndex < totalBits; i += 1) {
		if (i % 4 === 3) continue;
		const bit = pixels[i] & 1;
		out[bitIndex >> 3] |= bit << (7 - (bitIndex & 7));
		bitIndex += 1;
	}
	return out;
}

/**
 * Read a message back out of a picture.
 * @param {ImageBitmap} bitmap
 * @param {{passphrase?: string}} [options]
 * @returns {Promise<{message: string, encrypted: boolean}>}
 */
export async function extract(bitmap, { passphrase = "" } = {}) {
	const { width, height } = bitmap;
	if (capacityBytes(width, height) < 1) {
		throw new Error("This picture is too small to carry anything.");
	}

	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d", { willReadFrequently: true });
	context.drawImage(bitmap, 0, 0);
	const { data: pixels } = context.getImageData(0, 0, width, height);

	const header = readBits(pixels, HEADER_BYTES * 8);
	if (!MAGIC.every((byte, index) => header[index] === byte)) {
		throw new Error(
			"No hidden message found. The picture was re-compressed, resized, or never carried one.",
		);
	}

	const encrypted = (header[4] & FLAG_ENCRYPTED) !== 0;
	const length = readUint32(header, 33);
	const expectedCrc = readUint32(header, 37);
	if (length === 0 || HEADER_BYTES + length > capacityBytes(width, height)) {
		throw new Error("The hidden payload is damaged.");
	}

	const body = readBits(pixels, (HEADER_BYTES + length) * 8).slice(
		HEADER_BYTES,
		HEADER_BYTES + length,
	);

	if (encrypted) {
		if (!passphrase.trim()) {
			throw new Error("This message is locked. Enter the passphrase.");
		}
		const salt = header.slice(5, 21);
		const iv = header.slice(21, 33);
		const key = await deriveKey(passphrase.trim(), salt);
		let plain;
		try {
			plain = new Uint8Array(
				await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body),
			);
		} catch {
			throw new Error("Wrong passphrase.");
		}
		return { message: decoder.decode(plain), encrypted: true };
	}

	if (crc32(body) !== expectedCrc) {
		throw new Error("The hidden payload is damaged.");
	}
	return { message: decoder.decode(body), encrypted: false };
}

/**
 * Paint the low bit of every channel as pure black or white, so the
 * invisible channel becomes visible. Useful to show that something is there.
 */
export async function visualise(bitmap) {
	const { width, height } = bitmap;
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d", { willReadFrequently: true });
	context.drawImage(bitmap, 0, 0);
	const { data: pixels } = context.getImageData(0, 0, width, height);
	for (let i = 0; i < pixels.length; i += 1) {
		const low = (pixels[i] & 1) * 255;
		pixels[i] = low;
		if (i % 4 === 3) pixels[i] = 255;
	}
	context.putImageData(new ImageData(pixels, width, height), 0, 0);
	return canvas.convertToBlob({ type: "image/png" });
}
