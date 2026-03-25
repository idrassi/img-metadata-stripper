const test = require('node:test');
const assert = require('node:assert/strict');
const metadataCore = require('../metadata-core.js');

class Writer {
    constructor(size = 512) {
        this.buffer = Buffer.alloc(size);
        this.offset = 0;
    }

    seek(offset) {
        this.offset = offset;
    }

    writeUint8(value) {
        this.buffer.writeUInt8(value & 0xFF, this.offset);
        this.offset += 1;
    }

    writeUint16(value) {
        this.buffer.writeUInt16LE(value & 0xFFFF, this.offset);
        this.offset += 2;
    }

    writeUint32(value) {
        this.buffer.writeUInt32LE(value >>> 0, this.offset);
        this.offset += 4;
    }

    writeBytes(bytes) {
        Buffer.from(bytes).copy(this.buffer, this.offset);
        this.offset += bytes.length;
    }

    patchUint16(offset, value) {
        this.buffer.writeUInt16LE(value & 0xFFFF, offset);
    }

    patchUint32(offset, value) {
        this.buffer.writeUInt32LE(value >>> 0, offset);
    }

    toUint8Array() {
        return new Uint8Array(this.buffer.subarray(0, this.offset));
    }
}

function asciiBytes(value) {
    return new Uint8Array(Buffer.from(value, 'ascii'));
}

function pngChunk(type, payload) {
    const out = Buffer.alloc(12 + payload.length);
    out.writeUInt32BE(payload.length, 0);
    out.write(type, 4, 4, 'ascii');
    Buffer.from(payload).copy(out, 8);
    return new Uint8Array(out);
}

function jpegSegment(marker, payload) {
    const out = Buffer.alloc(payload.length + 4);
    out.writeUInt8(0xFF, 0);
    out.writeUInt8(marker, 1);
    out.writeUInt16BE(payload.length + 2, 2);
    Buffer.from(payload).copy(out, 4);
    return new Uint8Array(out);
}

function webpChunk(type, payload) {
    const size = payload.length;
    const paddedSize = size + (size & 1);
    const out = Buffer.alloc(8 + paddedSize);
    out.write(type, 0, 4, 'ascii');
    out.writeUInt32LE(size, 4);
    Buffer.from(payload).copy(out, 8);
    return new Uint8Array(out);
}

function buildTestExifTiff() {
    const writer = new Writer();
    const ifd0Offset = 8;
    const ifd0Entries = 5;
    const ifd0Size = 2 + ifd0Entries * 12 + 4;
    const exifIfdOffset = ifd0Offset + ifd0Size;
    const exifIfdEntries = 1;
    const exifIfdSize = 2 + exifIfdEntries * 12 + 4;
    const gpsIfdOffset = exifIfdOffset + exifIfdSize;
    const gpsIfdEntries = 1;
    const gpsIfdSize = 2 + gpsIfdEntries * 12 + 4;
    const ifd1Offset = gpsIfdOffset + gpsIfdSize;
    const ifd1Entries = 2;
    const ifd1Size = 2 + ifd1Entries * 12 + 4;
    const make = asciiBytes('Canon\0');
    const model = asciiBytes('EOS\0');
    const dateTime = asciiBytes('2024:01:02 03:04:05\0');
    const makerNote = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const thumbnail = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xD9]);
    const makeOffset = ifd1Offset + ifd1Size;
    const dateTimeOffset = makeOffset + make.length;
    const makerNoteOffset = dateTimeOffset + dateTime.length;
    const thumbnailOffset = makerNoteOffset + makerNote.length;

    writer.writeBytes(asciiBytes('II'));
    writer.writeUint16(42);
    writer.writeUint32(ifd0Offset);

    writer.seek(ifd0Offset);
    writer.writeUint16(ifd0Entries);
    let row = writer.offset;
    writer.patchUint16(row, 0x010F);
    writer.patchUint16(row + 2, 2);
    writer.patchUint32(row + 4, make.length);
    writer.patchUint32(row + 8, makeOffset);
    row += 12;
    writer.patchUint16(row, 0x0110);
    writer.patchUint16(row + 2, 2);
    writer.patchUint32(row + 4, model.length);
    Buffer.from(model).copy(writer.buffer, row + 8);
    row += 12;
    writer.patchUint16(row, 0x0132);
    writer.patchUint16(row + 2, 2);
    writer.patchUint32(row + 4, dateTime.length);
    writer.patchUint32(row + 8, dateTimeOffset);
    row += 12;
    writer.patchUint16(row, 0x8769);
    writer.patchUint16(row + 2, 4);
    writer.patchUint32(row + 4, 1);
    writer.patchUint32(row + 8, exifIfdOffset);
    row += 12;
    writer.patchUint16(row, 0x8825);
    writer.patchUint16(row + 2, 4);
    writer.patchUint32(row + 4, 1);
    writer.patchUint32(row + 8, gpsIfdOffset);
    writer.patchUint32(ifd0Offset + 2 + ifd0Entries * 12, ifd1Offset);

    writer.seek(exifIfdOffset);
    writer.writeUint16(exifIfdEntries);
    row = writer.offset;
    writer.patchUint16(row, 0x927C);
    writer.patchUint16(row + 2, 7);
    writer.patchUint32(row + 4, makerNote.length);
    writer.patchUint32(row + 8, makerNoteOffset);
    writer.patchUint32(exifIfdOffset + 2 + exifIfdEntries * 12, 0);

    writer.seek(gpsIfdOffset);
    writer.writeUint16(gpsIfdEntries);
    row = writer.offset;
    writer.patchUint16(row, 0x0001);
    writer.patchUint16(row + 2, 2);
    writer.patchUint32(row + 4, 2);
    Buffer.from(asciiBytes('N\0')).copy(writer.buffer, row + 8);
    writer.patchUint32(gpsIfdOffset + 2 + gpsIfdEntries * 12, 0);

    writer.seek(ifd1Offset);
    writer.writeUint16(ifd1Entries);
    row = writer.offset;
    writer.patchUint16(row, 0x0201);
    writer.patchUint16(row + 2, 4);
    writer.patchUint32(row + 4, 1);
    writer.patchUint32(row + 8, thumbnailOffset);
    row += 12;
    writer.patchUint16(row, 0x0202);
    writer.patchUint16(row + 2, 4);
    writer.patchUint32(row + 4, 1);
    writer.patchUint32(row + 8, thumbnail.length);
    writer.patchUint32(ifd1Offset + 2 + ifd1Entries * 12, 0);

    writer.seek(makeOffset);
    writer.writeBytes(make);
    writer.writeBytes(dateTime);
    writer.writeBytes(makerNote);
    writer.writeBytes(thumbnail);

    return writer.toUint8Array();
}

function buildPhotoshopPayload() {
    return Buffer.concat([
        Buffer.from('Photoshop 3.0\0', 'ascii'),
        Buffer.from('8BIM', 'ascii'),
        Buffer.from([0x04, 0x04]),
        Buffer.from([0x00, 0x00]),
        Buffer.from([0x00, 0x00, 0x00, 0x04]),
        Buffer.from([1, 2, 3, 4]),
        Buffer.from('8BIM', 'ascii'),
        Buffer.from([0x03, 0xE8]),
        Buffer.from([0x00, 0x00]),
        Buffer.from([0x00, 0x00, 0x00, 0x02]),
        Buffer.from([9, 9])
    ]);
}

function buildJpegFixture() {
    const exif = buildTestExifTiff();
    const sos = Uint8Array.from([0xFF, 0xDA, 0x00, 0x08, 0, 0, 0, 0, 0, 0, 0x11, 0x22, 0x33, 0xFF, 0xD9]);
    return Buffer.concat([
        Buffer.from([0xFF, 0xD8]),
        Buffer.from(jpegSegment(0xE0, Buffer.concat([Buffer.from('JFIF\0', 'ascii'), Buffer.alloc(9)]))),
        Buffer.from(jpegSegment(0xE1, Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), Buffer.from(exif)]))),
        Buffer.from(jpegSegment(0xE1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'ascii'))),
        Buffer.from(jpegSegment(0xED, buildPhotoshopPayload())),
        Buffer.from(jpegSegment(0xFE, Buffer.from('comment', 'ascii'))),
        Buffer.from(sos)
    ]);
}

function buildPngFixture() {
    const ihdr = Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        Buffer.from(pngChunk('IHDR', ihdr)),
        Buffer.from(pngChunk('eXIf', buildTestExifTiff())),
        Buffer.from(pngChunk('iTXt', asciiBytes('XML:com.adobe.xmp\0<x:xmpmeta/>'))),
        Buffer.from(pngChunk('iCCP', asciiBytes('icc\0profile'))),
        Buffer.from(pngChunk('tEXt', asciiBytes('Comment\0hello'))),
        Buffer.from(pngChunk('IEND', new Uint8Array(0)))
    ]);
}

function buildWebpFixture() {
    const chunks = [
        webpChunk('VP8X', Buffer.alloc(10)),
        webpChunk('EXIF', buildTestExifTiff()),
        webpChunk('XMP ', Buffer.from('<x:xmpmeta/>', 'ascii')),
        webpChunk('ICCP', Uint8Array.from([1, 2, 3])),
        webpChunk('VP8 ', Uint8Array.from([0]))
    ];
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 4, 'ascii');
    header.writeUInt32LE(body.length + 4, 4);
    header.write('WEBP', 8, 4, 'ascii');
    return Buffer.concat([header, body]);
}

function metadataTypes(metadata) {
    return metadata.map((entry) => entry.type);
}

test('detectMimeType recognizes the supported formats', () => {
    assert.equal(metadataCore.detectMimeType(new Uint8Array(buildJpegFixture())), 'image/jpeg');
    assert.equal(metadataCore.detectMimeType(new Uint8Array(buildPngFixture())), 'image/png');
    assert.equal(metadataCore.detectMimeType(new Uint8Array(buildWebpFixture())), 'image/webp');
});

test('JPEG lossless stripping removes only the requested metadata', () => {
    const input = new Uint8Array(buildJpegFixture());
    const before = metadataCore.detectMetadata(input, 'image/jpeg');
    assert.deepEqual(metadataTypes(before), ['JFIF', 'EXIF', 'XMP', 'Photoshop IRB', 'IPTC', 'Comment']);
    assert.equal(before.find((entry) => entry.type === 'EXIF').details.hasGPS, true);
    assert.equal(before.find((entry) => entry.type === 'EXIF').details.hasMakerNote, true);
    assert.equal(before.find((entry) => entry.type === 'EXIF').details.hasThumbnail, true);

    const output = metadataCore.stripMetadataLossless(input, 'image/jpeg', {
        stripExif: false,
        stripGps: true,
        stripMakerNote: true,
        stripXmp: false,
        stripIptc: true,
        stripThumbnail: true,
        stripFlashPix: false,
        stripPhotoshop: false,
        stripPrintIm: false,
        stripIcc: false,
        stripJfif: false,
        stripComment: true
    });
    const after = metadataCore.detectMetadata(output, 'image/jpeg');
    const exif = after.find((entry) => entry.type === 'EXIF');
    assert.ok(exif);
    assert.equal(exif.details.hasGPS, false);
    assert.equal(exif.details.hasMakerNote, false);
    assert.equal(exif.details.hasThumbnail, false);
    assert.ok(after.some((entry) => entry.type === 'JFIF'));
    assert.ok(after.some((entry) => entry.type === 'XMP'));
    assert.ok(after.some((entry) => entry.type === 'Photoshop IRB'));
    assert.ok(!after.some((entry) => entry.type === 'IPTC'));
    assert.ok(!after.some((entry) => entry.type === 'Comment'));
});

test('PNG lossless stripping handles EXIF subfields and text chunks', () => {
    const input = new Uint8Array(buildPngFixture());
    const output = metadataCore.stripMetadataLossless(input, 'image/png', {
        stripExif: false,
        stripGps: true,
        stripMakerNote: false,
        stripXmp: true,
        stripIptc: false,
        stripThumbnail: true,
        stripFlashPix: false,
        stripPhotoshop: false,
        stripPrintIm: false,
        stripIcc: true,
        stripJfif: false,
        stripComment: true
    });
    const after = metadataCore.detectMetadata(output, 'image/png');
    const exif = after.find((entry) => entry.type === 'EXIF');
    assert.ok(exif);
    assert.equal(exif.details.hasGPS, false);
    assert.equal(exif.details.hasThumbnail, false);
    assert.ok(!after.some((entry) => entry.type === 'XMP'));
    assert.ok(!after.some((entry) => entry.type === 'ICC Profile'));
    assert.ok(!after.some((entry) => entry.type === 'Comment'));
});

test('WebP lossless stripping removes XMP and ICC while keeping filtered EXIF', () => {
    const input = new Uint8Array(buildWebpFixture());
    const output = metadataCore.stripMetadataLossless(input, 'image/webp', {
        stripExif: false,
        stripGps: true,
        stripMakerNote: true,
        stripXmp: true,
        stripIptc: false,
        stripThumbnail: true,
        stripFlashPix: false,
        stripPhotoshop: false,
        stripPrintIm: false,
        stripIcc: true,
        stripJfif: false,
        stripComment: false
    });
    const after = metadataCore.detectMetadata(output, 'image/webp');
    const exif = after.find((entry) => entry.type === 'EXIF');
    assert.ok(exif);
    assert.equal(exif.details.hasGPS, false);
    assert.equal(exif.details.hasMakerNote, false);
    assert.equal(exif.details.hasThumbnail, false);
    assert.ok(!after.some((entry) => entry.type === 'XMP'));
    assert.ok(!after.some((entry) => entry.type === 'ICC Profile'));
});
