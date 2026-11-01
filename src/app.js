import {
	IMAGE_MODELS,
	composeBrief,
	fetchBalance,
	interrogate,
	renderCover,
} from "./api.js";
import { capacityBytes, embed, extract, visualise } from "./stego.js";

const $ = (selector) => document.querySelector(selector);

const ui = {
	connect: $("polli-connect"),
	keyState: $("#key-state"),
	form: $("#compose-form"),
	secret: $("#secret"),
	passphrase: $("#passphrase"),
	idea: $("#idea"),
	model: $("#model"),
	seed: $("#seed"),
	composeButton: $("#compose-button"),
	composeStatus: $("#compose-status"),
	preview: $("#preview"),
	stageEmpty: $("#stage-empty"),
	stageMeta: $("#stage-meta"),
	riddle: $("#riddle"),
	metaUsed: $("#meta-used"),
	metaSealed: $("#meta-sealed"),
	metaSize: $("#meta-size"),
	download: $("#download"),
	revealOwn: $("#reveal-own"),
	dropzone: $("#dropzone"),
	file: $("#file"),
	revealPassphrase: $("#reveal-passphrase"),
	extractButton: $("#extract-button"),
	revealStatus: $("#reveal-status"),
	revealed: $("#revealed"),
	askButton: $("#ask-button"),
	askStatus: $("#ask-status"),
	answer: $("#answer"),
	bits: $("#bits"),
};

const devKey =
	/^(localhost|127\.0\.0\.1)$/.test(location.hostname) &&
	new URLSearchParams(location.search).get("key");

const state = {
	// Local development hook: `?key=sk_...` on localhost only.
	key: devKey || null,
	blob: null,
	objectUrl: null,
	riddle: "",
	fileName: "hidden-ink.png",
};

for (const model of IMAGE_MODELS) {
	const option = document.createElement("option");
	option.value = model.id;
	option.textContent = model.label;
	ui.model.append(option);
}

function setStatus(element, message, { error = false } = {}) {
	element.textContent = message;
	element.classList.toggle("error", error);
}

function requireKey() {
	if (!state.key) {
		throw new Error(
			"Connect with Pollinations first — the pictures are paid from your own Pollen.",
		);
	}
}

/** Convert a blob into an ImageBitmap, which the steganography needs. */
async function toBitmap(blob) {
	return createImageBitmap(blob);
}

async function toDataUrl(blob, size = 768) {
	const bitmap = await toBitmap(blob);
	const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
	const canvas = new OffscreenCanvas(
		Math.round(bitmap.width * scale),
		Math.round(bitmap.height * scale),
	);
	const context = canvas.getContext("2d");
	context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	const jpeg = await canvas.convertToBlob({
		type: "image/jpeg",
		quality: 0.75,
	});
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.readAsDataURL(jpeg);
	});
}

function showPicture(blob) {
	if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
	state.blob = blob;
	state.objectUrl = URL.createObjectURL(blob);
	ui.preview.src = state.objectUrl;
	ui.preview.hidden = false;
	ui.stageEmpty.hidden = true;
	ui.stageMeta.hidden = false;
	ui.askButton.disabled = false;
	ui.bits.hidden = true;
	ui.answer.hidden = true;
	ui.askStatus.textContent = "";
}

ui.connect?.addEventListener("change", async () => {
	state.key = ui.connect.apiKey || null;
	if (!state.key) {
		ui.keyState.textContent =
			"Not connected. Sign in so your own Pollen pays for the pictures.";
		return;
	}
	ui.keyState.textContent = "Connected. Your Pollen, your budget.";
	try {
		const { balance } = await fetchBalance(state.key);
		ui.keyState.textContent = `Connected · ${Number(balance).toFixed(2)} Pollen left in this budget`;
	} catch {
		// Balance is a nicety; a failed call must not block composing.
	}
});

ui.form.addEventListener("submit", async (event) => {
	event.preventDefault();
	ui.composeButton.disabled = true;
	setStatus(ui.composeStatus, "Writing the brief…");

	try {
		requireKey();
		const secret = ui.secret.value.trim();
		if (!secret) throw new Error("Write the message you want to hide.");

		const model = ui.model.value;
		const seed = Number(ui.seed.value) || 1;
		const brief = await composeBrief({
			key: state.key,
			idea: ui.idea.value.trim(),
		});

		setStatus(ui.composeStatus, "Painting the cover…");
		const cover = await renderCover({
			key: state.key,
			prompt: brief.prompt,
			model,
			seed,
		});

		setStatus(ui.composeStatus, "Sealing the message into the pixels…");
		const bitmap = await toBitmap(cover);
		const result = await embed(bitmap, {
			message: secret,
			passphrase: ui.passphrase.value,
		});

		state.riddle = brief.riddle;
		showPicture(result.blob);
		ui.riddle.textContent = brief.riddle ? `“${brief.riddle}”` : brief.prompt;
		ui.metaUsed.textContent = `${result.used} / ${result.capacity} bytes`;
		ui.metaSealed.textContent = result.encrypted ? "AES-GCM" : "open";
		ui.metaSize.textContent = `${result.width}×${result.height}`;
		state.fileName = `hidden-ink-${seed}.png`;
		setStatus(
			ui.composeStatus,
			`Done. ${result.used} bytes hidden in ${result.width * result.height} pixels.`,
		);
	} catch (error) {
		setStatus(ui.composeStatus, error.message, { error: true });
	} finally {
		ui.composeButton.disabled = false;
	}
});

ui.download.addEventListener("click", () => {
	if (!state.objectUrl) return;
	const link = document.createElement("a");
	link.href = state.objectUrl;
	link.download = state.fileName;
	link.click();
});

ui.revealOwn.addEventListener("click", () => {
	ui.revealPassphrase.value = ui.passphrase.value;
	ui.dropzone.scrollIntoView({ behavior: "smooth", block: "center" });
	ui.revealPassphrase.focus();
	void reveal(state.blob);
});

ui.dropzone.addEventListener("click", () => ui.file.click());
ui.dropzone.addEventListener("keydown", (event) => {
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		ui.file.click();
	}
});

for (const type of ["dragenter", "dragover"]) {
	ui.dropzone.addEventListener(type, (event) => {
		event.preventDefault();
		ui.dropzone.classList.add("dragging");
	});
}

for (const type of ["dragleave", "drop"]) {
	ui.dropzone.addEventListener(type, (event) => {
		event.preventDefault();
		ui.dropzone.classList.remove("dragging");
	});
}

ui.dropzone.addEventListener("drop", (event) => {
	const [file] = event.dataTransfer?.files ?? [];
	if (file) void reveal(file);
});

ui.file.addEventListener("change", () => {
	const [file] = ui.file.files ?? [];
	if (file) void reveal(file);
});

async function reveal(blob) {
	setStatus(ui.revealStatus, "Reading the low bits…");
	try {
		const bitmap = await toBitmap(blob);
		const result = await extract(bitmap, {
			passphrase: ui.revealPassphrase.value,
		});
		ui.revealed.hidden = false;
		ui.revealed.textContent = result.message;
		setStatus(
			ui.revealStatus,
			result.encrypted
				? `Revealed ${result.message.length} characters (sealed).`
				: `Revealed ${result.message.length} characters.`,
		);
	} catch (error) {
		ui.revealed.hidden = true;
		setStatus(ui.revealStatus, error.message, { error: true });
	}
}

ui.askButton.addEventListener("click", async () => {
	if (!state.blob) return;
	ui.askButton.disabled = true;
	setStatus(ui.askStatus, "Sending the picture to a vision model…");
	try {
		requireKey();
		const dataUrl = await toDataUrl(state.blob);
		const answer = await interrogate({
			key: state.key,
			imageDataUrl: dataUrl,
			riddle: state.riddle,
		});
		ui.answer.hidden = false;
		ui.answer.textContent = answer || "(silence)";
		setStatus(ui.askStatus, "The model saw the picture, not the payload.");
	} catch (error) {
		setStatus(ui.askStatus, error.message, { error: true });
	} finally {
		ui.askButton.disabled = false;
	}
});

document.querySelector(".bits").addEventListener("toggle", async (event) => {
	if (!event.target.open || ui.bits.src || !state.blob) return;
	const bitmap = await toBitmap(state.blob);
	const blob = await visualise(bitmap);
	ui.bits.src = URL.createObjectURL(blob);
	ui.bits.hidden = false;
});

// Keep capacity hints honest for the default carrier size.
ui.seed.addEventListener("change", () => {
	const capacity = capacityBytes(1024, 1024);
	ui.idea.placeholder = `a paper boat on a quiet pond (${capacity} bytes of room)`;
});
