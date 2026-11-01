/**
 * Thin client for the Pollinations API. Every call spends the key that the
 * visitor authorised through the Connect button, so the app never pays.
 */

const BASE = "https://gen.pollinations.ai";

export const IMAGE_MODELS = [
	{ id: "black-forest-labs/flux.1-schnell", label: "FLUX.1 Schnell · fast" },
	{ id: "tongyi-mai/z-image-turbo", label: "Z-Image Turbo · crisp" },
	{ id: "lykon/dreamshaper-8-lcm", label: "DreamShaper 8 · painterly" },
];

export const TEXT_MODEL = "z-ai/glm-5.3-flash";

export class ApiError extends Error {
	constructor(message, status) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

async function readError(response) {
	try {
		const body = await response.json();
		return body?.error?.message || body?.message || response.statusText;
	} catch {
		return response.statusText;
	}
}

function auth(key) {
	return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * Ask a text model for a picture brief plus a one-line riddle.
 * @returns {Promise<{prompt: string, riddle: string}>}
 */
export async function composeBrief({ key, idea, model = TEXT_MODEL }) {
	const response = await fetch(`${BASE}/v1/chat/completions`, {
		method: "POST",
		headers: { ...auth(key), "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "system",
					content:
						"You art-direct images that look completely ordinary. Answer with JSON only.",
				},
				{
					role: "user",
					content: [
						"Turn this idea into a picture brief for an image model.",
						`Idea: ${idea || "a quiet, ordinary scene"}`,
						"Rules: no text, no letters, no captions, no watermark, no frames. One subject, calm light, something a passer-by would not look at twice.",
						'Reply as {"prompt": "...", "riddle": "..."} where riddle is one short mysterious sentence hinting that something is hidden, without saying what.',
					].join("\n"),
				},
			],
			max_tokens: 700,
			reasoning_effort: "low",
		}),
	});

	if (!response.ok) {
		throw new ApiError(await readError(response), response.status);
	}

	const body = await response.json();
	const text = body?.choices?.[0]?.message?.content ?? "";
	const brief = parseJson(text);
	if (!brief?.prompt) {
		return { prompt: idea || "a quiet, ordinary scene", riddle: "" };
	}
	return {
		prompt: String(brief.prompt).slice(0, 800),
		riddle: String(brief.riddle ?? "").slice(0, 240),
	};
}

function parseJson(text) {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

/**
 * Render the cover picture.
 * @returns {Promise<Blob>}
 */
export async function renderCover({ key, prompt, model, seed, size = 1024 }) {
	const params = new URLSearchParams({
		model,
		width: String(size),
		height: String(size),
		seed: String(seed),
		nologo: "true",
		safe: "true",
	});
	const response = await fetch(
		`${BASE}/image/${encodeURIComponent(prompt)}?${params}`,
		{ headers: auth(key) },
	);
	if (!response.ok) {
		throw new ApiError(await readError(response), response.status);
	}
	return response.blob();
}

/**
 * Show a vision model the finished picture and ask it to find what is hidden.
 * It almost never can: the payload lives in bits the model never receives.
 */
export async function interrogate({
	key,
	imageDataUrl,
	riddle,
	model = TEXT_MODEL,
}) {
	const response = await fetch(`${BASE}/v1/chat/completions`, {
		method: "POST",
		headers: { ...auth(key), "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: [
								"Someone may have hidden a message inside this image.",
								riddle ? `A riddle left with it: "${riddle}"` : "",
								"Look closely. If you find a hidden text, quote it exactly. If you find nothing, say what you inspected and why you are unsure. Answer in at most 60 words.",
							]
								.filter(Boolean)
								.join("\n"),
						},
						{ type: "image_url", image_url: { url: imageDataUrl } },
					],
				},
			],
			max_tokens: 500,
			reasoning_effort: "low",
		}),
	});

	if (!response.ok) {
		throw new ApiError(await readError(response), response.status);
	}
	const body = await response.json();
	return (body?.choices?.[0]?.message?.content ?? "").trim();
}

/** Balance and plan for the connected key, used for the small status line. */
export async function fetchBalance(key) {
	const response = await fetch(`${BASE}/account/balance`, {
		headers: auth(key),
	});
	if (!response.ok) {
		throw new ApiError(await readError(response), response.status);
	}
	return response.json();
}
