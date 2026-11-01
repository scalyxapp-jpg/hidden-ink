# Hidden Ink

A message hidden inside a picture nobody would look at twice.

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

**[Try it →](https://scalyxapp-jpg.github.io/hidden-ink/)**

Hidden Ink asks a Pollinations text model to art-direct an ordinary scene, renders
it with a Pollinations image model, and then seals your message into the lowest
bit of every colour channel of the result. The picture looks untouched. A reader
who has the file and (optionally) the passphrase gets the words back in the
browser, offline.

The same picture can be handed to a vision model, which will look at it and find
nothing. That is the point: a model receives a re-encoded, downsampled copy of
the image, so the low bit never reaches it — the observation from
[“How does Fable 5.1 hide messages in images?”](https://www.lesswrong.com/posts/WHEQps5PK8LrrcTAb/how-does-fable-5-1-hide-messages-in-images)
that started this build.

## What it does

- **Compose** — idea → prompt brief + riddle (text model) → cover (image model) → payload embedded locally.
- **Reveal** — drop the PNG, keep it on your device, read the low bits back.
- **Interrogate** — send the picture to a vision model and watch it fail, then look at the hidden channel yourself.
- **Seal** — optional passphrase, PBKDF2-SHA256 (150k iterations) + AES-GCM, header, length and CRC-32.

## Format

```
0..3    magic "HNK1"
4       flags (bit 0 = AES-GCM)
5..20   salt (16 bytes, zero when open)
21..32  IV (12 bytes, zero when open)
33..36  payload length, big endian
37..40  CRC-32 of the stored payload
41..    payload, written MSB first into the low bit of R, G, B
```

A 1024 × 1024 carrier holds 393,175 bytes; the app caps messages at 1,500
characters, which is 1,541 bytes sealed.

The payload survives PNG re-encoding, screenshots and chat apps that keep the
original bytes. It does **not** survive JPEG re-compression, resizing or
cropping — the message is exactly as fragile as the file that carries it.

## Paying for it

The app has no key of its own. Visitors sign in with the **Connect** button
([Bring Your Own Pollen](https://github.com/pollinations/pollinations/blob/main/BRING_YOUR_OWN_POLLEN.md));
the resulting scoped key, its budget and its expiry stay in the tab, and every
picture is paid from the visitor's balance.

## Run it locally

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/?key=sk_yourkey` — the query parameter is a
localhost-only development hook so you can test without the OAuth round trip.

## Stack

Vanilla ES modules, no build step, no dependencies. `crypto.subtle` for sealing,
`OffscreenCanvas` for pixels, the Pollinations API for words and pictures.

## License

MIT
