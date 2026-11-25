# Converter Studio for Figma

A Figma plugin by [Converter Studio](https://converter.studio) that exports layers to the formats
Figma does not write and places the files Figma cannot open. **WebP, TIFF and ICO favicons are
made on your computer**, inside the plugin, with no account and nothing uploaded. **AVIF, a
smaller PDF, and camera RAW, TIFF, Illustrator or EPS files** are converted in the Converter
Studio cloud, only when you choose it, with your Converter Studio account's credits.

![The plugin's Export tab: two layers saved as WebP on this computer](docs/export.png)

## What it does

**Export.** Select up to 20 layers, frames or components, pick a format and press **Export**.
One layer is saved as one file; several go into one ZIP. Each format says where it is made:

| Format        | Where                                 | Settings                                                                     |
| ------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| WebP          | In Figma (your computer)              | scale 1× to 4×, quality, "at most … KB"                                      |
| TIFF          | In Figma                              | scale; lossless, with transparency                                           |
| ICO (favicon) | In Figma                              | 16, 32 and 48 px in one file (each drawn by Figma), or one size up to 256 px |
| AVIF          | Converter Studio cloud (uses credits) | scale, quality, "at most … KB"                                               |
| PDF (smaller) | Converter Studio cloud (uses credits) | Figma's PDF with its pictures compressed: light, balanced or strong          |

If something cannot be made on your computer (a layer too large for the browser, or WebP in
Figma on Safari, which writes no WebP), the plugin says why and offers **Try in the cloud (uses
credits)**. It never sends anything to the cloud on its own.

**Place a file.** Choose a file Figma cannot open. AVIF, BMP and ICO pictures are read on your
computer and placed as an image layer. Camera RAW (DNG, CR2, NEF, ARW) and TIFF files become a
PNG image layer (up to 2560 px by default, or up to 4096 px, Figma's largest), and Illustrator
(AI) or EPS files become editable vector layers (or a PNG), in the Converter Studio cloud. The
layer goes into the selected frame, scaled down to fit and centred, or onto the page in the
middle of your view, as one undo step. PNG, JPG, GIF, WebP, HEIC and SVG files are left to Figma:
drag them onto the canvas.

![The Place tab: a camera RAW file to be converted in the cloud and placed](docs/place.png)

## Install and set up

1. In Figma, open **Plugins** (or **Resources**, Shift + I), search for **Converter Studio** and
   run it. The plugin works in Figma Design.
2. The WebP, TIFF and ICO exports and the AVIF, BMP and ICO pictures work right away.
3. For the cloud, create a Converter Studio account (free accounts get 25 credits a day; most
   conversions cost 1 credit) and an API key on your
   [account page](https://converter.studio/account#api-keys). In the plugin, open **Settings**,
   paste the key and press **Connect**: the plugin checks it with Converter Studio and shows your
   credits. Conversions up to 3 credits start on their own; dearer ones show the price and ask.

Plans and prices: [converter.studio/pricing](https://converter.studio/pricing).

## Limits

- Up to 20 layers per export, converted one after the other; keep the plugin open until it
  finishes. Very large layers (over 16,384 px a side or about 120 million pixels at the chosen
  scale) cannot be made on your computer; the cloud can make them when you ask.
- Figma takes pictures up to 4096 px a side; larger ones are made smaller before they are placed.
- What is made on your computer depends on the browser Figma runs in. The desktop app, Chrome,
  Edge and Firefox write WebP; where the browser cannot (Safari), the plugin offers WebP in the
  cloud instead. Firefox saves a WebP file and also opens it in a new tab.
- No CMYK PDF: Converter Studio does not convert colours to CMYK. PSD files and HEIC photos are
  not converted (Figma places HEIC itself).
- File sizes follow your Converter Studio plan. The panel is in English.

## Privacy and security

- **On your computer:** WebP, TIFF and ICO exports, and the AVIF, BMP and ICO pictures you place,
  are made inside the plugin from Figma's own export. Nothing is uploaded.
- **In the cloud, only when you choose it:** Figma's PNG (or PDF) of each layer you export to
  AVIF or a smaller PDF, or the file you choose to place, is uploaded to Converter Studio
  (converter.studio) with the settings you picked, converted, and fetched back into the plugin.
  Converter Studio deletes the files after 6 hours. See the
  [privacy policy](https://converter.studio/privacy). Nothing else from your Figma file is read
  or sent.
- **The API key** is kept by Figma for this plugin on this computer (`figma.clientStorage`): not
  in your Figma files, and not visible to anyone you share them with. It is sent only to
  Converter Studio's API. **Disconnect** deletes it; you can also delete the key on your account
  page at any time.
- **Network access:** the manifest allows only `https://converter.studio/api/` (Figma shows it as
  "Restricted network access"). Requests carry no cookies, and the key is never logged.
- The plugin asks Figma for no extra permissions (no current user, no team library, no payments).

## How it is built

| Path                     | What                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `public/manifest.json`   | The plugin's manifest: Figma Design, `dynamic-page`, network access to the Converter Studio API   |
| `src/code/`              | `code.js`: runs in Figma's sandbox with the `figma` API; exports layers, places pictures and SVGs |
| `src/ui/`                | The panel (`ui.html`): the export and place flows, the API client, the panel itself               |
| `src/ui/encode/`         | Our own small TIFF, ICO and ZIP writers                                                           |
| `src/shared/messages.ts` | The messages between the two, checked on arrival on both sides                                    |
| `build.mjs`              | Builds `dist/` (`manifest.json`, `code.js`, `ui.html`) and checks it                              |
| `test/`                  | Unit tests with a stand-in Figma API, browser canvas and Converter Studio API                     |

Plain TypeScript and DOM, no framework, no runtime dependencies. The code is bundled with
esbuild and not minified. `code.js` is type-checked without the DOM's types (Figma's sandbox has
none) against Figma's official `@figma/plugin-typings`.

```sh
npm ci              # Node 22.13 or later
npm test            # unit tests (Vitest; the panel's in jsdom): no network
npm run typecheck
npm run build       # dist/: manifest.json, code.js, ui.html
node build.mjs --api http://localhost:8080/api
                    # a development build against another Converter Studio API
```

To run your build: Figma desktop app → **Plugins → Development → Import plugin from
manifest…** → `dist/manifest.json`.

## Support

Questions and problems: support@converter.studio or
[GitHub issues](https://github.com/tariksucu/figma-converter-studio/issues).
More about the API: [converter.studio/developers](https://converter.studio/developers).

## License

MIT, © Converter Studio.
