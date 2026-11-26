# Changelog

## 1.1.0

- **JPG and PNG under a size, on your computer, free and with no account.** Export the selected
  layers as JPG or PNG with an optional "at most … KB":
  - **JPG** takes the highest quality that stays under the size (at most 9 tries per file);
    transparent areas become white.
  - **PNG** is lossless first: our own writer picks the smallest colour type (a palette when the
    layer has 256 colours or fewer, grey, RGB, with or without alpha) and a filter for each row,
    and the plugin keeps whichever is smaller, Figma's PNG or ours. Only when you tick **Fewer
    colours (lossy)** does it reduce the colours to a palette (image-q's Wu quantizer), as many
    as fit the size, or 256 when no size is set.
  - When a size cannot be reached, the closest (smallest) file is saved anyway, and its row and
    a note say so and what would help.
- **Several scales at once**: tick 1×, 2×, 3× and 4× for JPG, PNG, WebP and TIFF; each layer is
  exported at each scale, named as Figma names them (`Hero.jpg`, `Hero@2x.jpg`), in one ZIP.
- **Maximum width and height** for JPG, PNG, WebP and AVIF: Figma renders the layer at exactly
  that width or height (never larger than the chosen scale), and a layer whose shadow makes the
  export larger is drawn smaller to fit.
- **The last export's settings come back** when the plugin opens (format, scales, quality, size,
  maximum width and height; kept by Figma for this plugin on this computer,
  `figma.clientStorage`), so a regular hand-off is: select the layers, press Export.
- JPG is now the first format in the list (it was WebP). A JPG layer too large for this
  computer can be made in the cloud when you ask, as before for the other formats.
- WebP with "at most … KB" now behaves like JPG: when the size cannot be reached even at the
  lowest quality, the smallest file is saved and marked as over, instead of failing.
- Third-party code: [image-q](https://github.com/ibezkrovnyi/image-quantization) 4.0.0 (MIT),
  bundled unmodified from npm, only for PNG's fewer colours. Its licence is at the top of the
  panel's script.

## 1.0.0

- Export the selected layers (up to 20; several go into one ZIP) as **WebP** (a quality, or a
  size it must stay under), **TIFF** (lossless, RGB or RGB with alpha) and **ICO** (a favicon
  with 16, 32 and 48 px, each rendered by Figma at its size, or one size up to 256 px), made on
  your computer.
- Export as **AVIF** or a **smaller PDF** in the Converter Studio cloud, with your API key and
  credits. A format made on your computer can be sent to the cloud too, when you ask after the
  local way failed ("Try in the cloud").
- Place files Figma cannot open: AVIF, BMP and ICO pictures read on your computer; camera RAW
  (DNG, CR2, NEF, ARW), TIFF, Illustrator (AI) and EPS files converted in the cloud (pictures as
  PNG fills, drawings as editable vector layers), into the selected frame or the middle of the
  view.
- The API key is kept by Figma for this plugin on this computer (`figma.clientStorage`).
