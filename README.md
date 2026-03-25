# Metadata Stripper

A client-side web tool to detect and remove metadata from images — directly in your browser. No uploads, no servers, no tracking. Your files never leave your device.

## Features

- **12 metadata types detected** — EXIF, GPS, XMP, IPTC, ICC Profile, MakerNote, Thumbnails, FlashPix, Photoshop IRB, PrintIM, JFIF, and Comments
- **Granular control** — losslessly strip or preserve specific metadata types when keeping the original format
- **Batch processing** — drop multiple files at once, download individually or as a ZIP
- **Format conversion** — output as JPEG, PNG, or WebP with adjustable quality and a clean re-encode
- **EXIF details** — shows camera make/model, date taken, and GPS presence with visual privacy warnings
- **PWA support** — install as a desktop or mobile app for offline use
- **Accessible** — ARIA labels, keyboard navigation, and focus management

## Supported Formats

| Format | Detection | Output |
|--------|-----------|--------|
| JPEG   | Full       | Yes    |
| PNG    | Full       | Yes    |
| WebP   | Full       | Yes    |

## Privacy

All processing runs entirely in your browser using the Canvas API. Images are never uploaded to any server.

## Output Modes

- **Auto (keep original format)** — performs lossless metadata filtering for JPEG, PNG, and WebP so granular metadata toggles work as expected
- **JPEG / PNG / WebP output** — re-encodes the image into the selected format and produces a clean file without carrying metadata forward

## Usage

1. Open [idrassi.github.io/img-metadata-stripper](https://idrassi.github.io/img-metadata-stripper) or serve `index.html` locally
2. Drop one or more images onto the drop zone
3. Review detected metadata and adjust which types to strip
4. Click **Strip All Metadata**
5. Download cleaned images individually or as a ZIP

## Development

No build step required. Serve `index.html` with any static file server:

```bash
npx serve .
# or
python -m http.server 8000
```

Run the metadata-core tests with:

```bash
node --test tests/metadata-core.test.js
```

## Tech Stack

- Vanilla HTML/CSS/JS (single-file architecture)
- [JSZip](https://stuk.github.io/jszip/) for batch ZIP downloads
- Service Worker for PWA offline support

## License

[MIT](LICENSE)
