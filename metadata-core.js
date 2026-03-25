(function (globalScope) {
    'use strict';

    const SUPPORTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    const ACCEPT_ATTRIBUTE = SUPPORTED_MIME_TYPES.join(',');
    const TIFF_TYPE_SIZES = {
        1: 1,
        2: 1,
        3: 2,
        4: 4,
        5: 8,
        7: 1,
        9: 4,
        10: 8,
        11: 4,
        12: 8
    };
    const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const JPEG_SOI = Uint8Array.from([0xFF, 0xD8]);
    const EXIF_PREFIX = Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
    const ICC_PREFIX = Uint8Array.from([
        0x49, 0x43, 0x43, 0x5F, 0x50, 0x52, 0x4F, 0x46, 0x49, 0x4C, 0x45, 0x00
    ]);
    const PHOTOSHOP_PREFIX = Uint8Array.from([
        0x50, 0x68, 0x6F, 0x74, 0x6F, 0x73, 0x68, 0x6F, 0x70, 0x20, 0x33, 0x2E, 0x30, 0x00
    ]);
    const XMP_JPEG_PREFIX = 'http://ns.adobe.com/xap/1.0/\u0000';
    const XMP_JPEG_EXTENDED_PREFIX = 'http://ns.adobe.com/xmp/extension/\u0000';
    const COMMENT_KEYWORDS = new Set(['comment', 'description']);

    function asciiString(uint8, start = 0, end = uint8.length) {
        let out = '';
        for (let i = start; i < end && i < uint8.length; i += 1) {
            out += String.fromCharCode(uint8[i]);
        }
        return out;
    }

    function bytesEqual(left, right) {
        if (!left || !right || left.length !== right.length) {
            return false;
        }
        for (let i = 0; i < left.length; i += 1) {
            if (left[i] !== right[i]) {
                return false;
            }
        }
        return true;
    }

    function startsWithBytes(source, prefix, offset = 0) {
        if (!source || source.length < offset + prefix.length) {
            return false;
        }
        for (let i = 0; i < prefix.length; i += 1) {
            if (source[offset + i] !== prefix[i]) {
                return false;
            }
        }
        return true;
    }

    function concatBytes(chunks) {
        let total = 0;
        for (const chunk of chunks) {
            total += chunk.length;
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }

    function padBytes(bytes, size) {
        if (bytes.length >= size) {
            return bytes.slice(0, size);
        }
        const out = new Uint8Array(size);
        out.set(bytes);
        return out;
    }

    function detectMimeType(uint8) {
        if (!uint8 || uint8.length < 12) {
            return '';
        }
        if (uint8[0] === 0xFF && uint8[1] === 0xD8 && uint8[2] === 0xFF) {
            return 'image/jpeg';
        }
        if (startsWithBytes(uint8, PNG_SIGNATURE)) {
            return 'image/png';
        }
        if (
            uint8[0] === 0x52 &&
            uint8[1] === 0x49 &&
            uint8[2] === 0x46 &&
            uint8[3] === 0x46 &&
            uint8[8] === 0x57 &&
            uint8[9] === 0x45 &&
            uint8[10] === 0x42 &&
            uint8[11] === 0x50
        ) {
            return 'image/webp';
        }
        return '';
    }

    function normalizeMimeType(mimeType, bytes) {
        const detected = detectMimeType(bytes);
        if (mimeType && SUPPORTED_MIME_TYPES.includes(mimeType)) {
            return mimeType;
        }
        return detected;
    }

    function validateFileType(uint8, claimedType) {
        const detected = detectMimeType(uint8);
        if (!detected) {
            return false;
        }
        if (!claimedType) {
            return true;
        }
        return claimedType === detected;
    }

    function getTypeSize(type) {
        return TIFF_TYPE_SIZES[type] || 0;
    }

    function readString(bytes) {
        const chars = [];
        for (let i = 0; i < bytes.length; i += 1) {
            const value = bytes[i];
            if (value === 0) {
                break;
            }
            if (value >= 32 && value <= 126) {
                chars.push(String.fromCharCode(value));
            }
        }
        return chars.join('');
    }

    function createEndianTools(bytes) {
        const byteOrder =
            bytes[0] === 0x49 && bytes[1] === 0x49
                ? 'little'
                : bytes[0] === 0x4D && bytes[1] === 0x4D
                    ? 'big'
                    : null;

        const read16 = (offset) => {
            if (offset < 0 || offset + 2 > bytes.length) {
                return 0;
            }
            if (byteOrder === 'little') {
                return bytes[offset] | (bytes[offset + 1] << 8);
            }
            return (bytes[offset] << 8) | bytes[offset + 1];
        };

        const read32 = (offset) => {
            if (offset < 0 || offset + 4 > bytes.length) {
                return 0;
            }
            if (byteOrder === 'little') {
                return (
                    bytes[offset] |
                    (bytes[offset + 1] << 8) |
                    (bytes[offset + 2] << 16) |
                    ((bytes[offset + 3] << 24) >>> 0)
                ) >>> 0;
            }
            return (
                ((bytes[offset] << 24) >>> 0) |
                (bytes[offset + 1] << 16) |
                (bytes[offset + 2] << 8) |
                bytes[offset + 3]
            ) >>> 0;
        };

        return {
            byteOrder,
            littleEndian: byteOrder === 'little',
            read16,
            read32
        };
    }

    function parseExifIfd(bytes, offset, visited, kind) {
        const tools = createEndianTools(bytes);
        if (!tools.byteOrder || offset < 8 || offset + 2 > bytes.length || visited.has(offset)) {
            return null;
        }

        visited.add(offset);
        const entryCount = tools.read16(offset);
        const entries = [];
        const nextOffsetPosition = offset + 2 + entryCount * 12;
        if (nextOffsetPosition + 4 > bytes.length) {
            return null;
        }

        for (let i = 0; i < entryCount; i += 1) {
            const entryOffset = offset + 2 + i * 12;
            const tag = tools.read16(entryOffset);
            const type = tools.read16(entryOffset + 2);
            const count = tools.read32(entryOffset + 4);
            const inlineValue = bytes.slice(entryOffset + 8, entryOffset + 12);
            const byteLength = (getTypeSize(type) * count) >>> 0;
            const valueOffset = tools.read32(entryOffset + 8);
            const entry = {
                tag,
                type,
                count,
                byteLength,
                inlineValue,
                dataBytes: null,
                childIfd: null
            };

            if ((tag === 0x8769 || tag === 0x8825 || tag === 0xA005) && count >= 1) {
                const childKind =
                    tag === 0x8769 ? 'exif' : tag === 0x8825 ? 'gps' : 'interop';
                entry.childIfd = parseExifIfd(bytes, valueOffset, visited, childKind);
            } else if (byteLength > 4 && valueOffset > 0 && valueOffset + byteLength <= bytes.length) {
                entry.dataBytes = bytes.slice(valueOffset, valueOffset + byteLength);
            } else if (byteLength > 0 && byteLength <= 4) {
                entry.dataBytes = inlineValue.slice(0, byteLength);
            }

            entries.push(entry);
        }

        const ifd = {
            kind,
            entries,
            nextIfd: null,
            thumbnailData: null,
            thumbnailMode: null
        };
        const nextOffset = tools.read32(nextOffsetPosition);
        if (nextOffset) {
            ifd.nextIfd = parseExifIfd(bytes, nextOffset, visited, kind === 'ifd0' ? 'ifd1' : 'next');
        }

        if (kind === 'ifd1') {
            const jpegOffsetEntry = entries.find((entry) => entry.tag === 0x0201 && entry.count === 1);
            const jpegLengthEntry = entries.find((entry) => entry.tag === 0x0202 && entry.count === 1);
            if (jpegOffsetEntry && jpegLengthEntry) {
                const jpegOffset = tools.read32(offset + 2 + entries.indexOf(jpegOffsetEntry) * 12 + 8);
                const jpegLength = tools.read32(offset + 2 + entries.indexOf(jpegLengthEntry) * 12 + 8);
                if (jpegOffset > 0 && jpegLength > 0 && jpegOffset + jpegLength <= bytes.length) {
                    ifd.thumbnailData = bytes.slice(jpegOffset, jpegOffset + jpegLength);
                    ifd.thumbnailMode = 'jpeg';
                }
            } else {
                const stripOffsetEntry = entries.find((entry) => entry.tag === 0x0111 && entry.count === 1);
                const stripLengthEntry = entries.find((entry) => entry.tag === 0x0117 && entry.count === 1);
                if (stripOffsetEntry && stripLengthEntry) {
                    const stripOffset = tools.read32(offset + 2 + entries.indexOf(stripOffsetEntry) * 12 + 8);
                    const stripLength = tools.read32(offset + 2 + entries.indexOf(stripLengthEntry) * 12 + 8);
                    if (stripOffset > 0 && stripLength > 0 && stripOffset + stripLength <= bytes.length) {
                        ifd.thumbnailData = bytes.slice(stripOffset, stripOffset + stripLength);
                        ifd.thumbnailMode = 'strip';
                    }
                }
            }
        }

        return ifd;
    }

    function parseExifStructure(bytes) {
        const tools = createEndianTools(bytes);
        if (!tools.byteOrder || bytes.length < 8 || tools.read16(2) !== 42) {
            return null;
        }
        const ifd0Offset = tools.read32(4);
        const ifd0 = parseExifIfd(bytes, ifd0Offset, new Set(), 'ifd0');
        if (!ifd0) {
            return null;
        }
        return {
            littleEndian: tools.littleEndian,
            ifd0
        };
    }

    function getExifEntry(ifd, tag) {
        if (!ifd) {
            return null;
        }
        return ifd.entries.find((entry) => entry.tag === tag) || null;
    }

    function readExifString(ifd, tag) {
        const entry = getExifEntry(ifd, tag);
        if (!entry || !entry.dataBytes) {
            return '';
        }
        return readString(entry.dataBytes);
    }

    function parseExifDetails(exifData) {
        const details = {
            hasGPS: false,
            hasThumbnail: false,
            hasMakerNote: false,
            cameraMake: null,
            cameraModel: null,
            dateTime: null
        };

        const structure = parseExifStructure(exifData);
        if (!structure) {
            return details;
        }

        const ifd0 = structure.ifd0;
        const exifIfdEntry = getExifEntry(ifd0, 0x8769);
        const gpsIfdEntry = getExifEntry(ifd0, 0x8825);
        const exifIfd = exifIfdEntry ? exifIfdEntry.childIfd : null;

        details.hasGPS = Boolean(gpsIfdEntry && gpsIfdEntry.childIfd);
        details.hasMakerNote = Boolean(exifIfd && getExifEntry(exifIfd, 0x927C));
        details.hasThumbnail = Boolean(ifd0.nextIfd && ifd0.nextIfd.thumbnailData);
        details.cameraMake = readExifString(ifd0, 0x010F) || null;
        details.cameraModel = readExifString(ifd0, 0x0110) || null;
        details.dateTime =
            readExifString(exifIfd, 0x9003) ||
            readExifString(exifIfd, 0x9004) ||
            readExifString(ifd0, 0x0132) ||
            null;

        return details;
    }

    class BinaryWriter {
        constructor(littleEndian, initialSize = 1024) {
            this.littleEndian = littleEndian;
            this.buffer = new ArrayBuffer(initialSize);
            this.view = new DataView(this.buffer);
            this.bytes = new Uint8Array(this.buffer);
            this.position = 0;
        }

        ensure(extra) {
            const required = this.position + extra;
            if (required <= this.buffer.byteLength) {
                return;
            }
            let nextSize = this.buffer.byteLength;
            while (nextSize < required) {
                nextSize *= 2;
            }
            const nextBuffer = new ArrayBuffer(nextSize);
            const nextBytes = new Uint8Array(nextBuffer);
            nextBytes.set(this.bytes.slice(0, this.position));
            this.buffer = nextBuffer;
            this.view = new DataView(this.buffer);
            this.bytes = nextBytes;
        }

        tell() {
            return this.position;
        }

        seek(position) {
            this.position = position;
        }

        align(modulo = 2) {
            while (this.position % modulo !== 0) {
                this.writeUint8(0);
            }
        }

        writeUint8(value) {
            this.ensure(1);
            this.bytes[this.position] = value & 0xFF;
            this.position += 1;
        }

        writeUint16(value) {
            this.ensure(2);
            this.view.setUint16(this.position, value & 0xFFFF, this.littleEndian);
            this.position += 2;
        }

        writeUint32(value) {
            this.ensure(4);
            this.view.setUint32(this.position, value >>> 0, this.littleEndian);
            this.position += 4;
        }

        writeBytes(value) {
            this.ensure(value.length);
            this.bytes.set(value, this.position);
            this.position += value.length;
        }

        patchUint16(position, value) {
            this.view.setUint16(position, value & 0xFFFF, this.littleEndian);
        }

        patchUint32(position, value) {
            this.view.setUint32(position, value >>> 0, this.littleEndian);
        }

        patchBytes(position, value) {
            this.bytes.set(value, position);
        }

        toUint8Array() {
            return this.bytes.slice(0, this.position);
        }
    }

    function sanitizeIfdEntries(ifd) {
        if (!ifd) {
            return null;
        }

        ifd.entries = ifd.entries.filter((entry) => {
            if (entry.tag === 0x8769 || entry.tag === 0x8825 || entry.tag === 0xA005) {
                return Boolean(entry.childIfd && entry.childIfd.entries.length > 0);
            }
            if (entry.byteLength > 4) {
                return Boolean(entry.dataBytes && entry.dataBytes.length === entry.byteLength);
            }
            return true;
        });

        if (ifd.nextIfd) {
            sanitizeIfdEntries(ifd.nextIfd);
            if (ifd.nextIfd.entries.length === 0) {
                ifd.nextIfd = null;
            }
        }

        return ifd;
    }

    function applyExifFilters(structure, options) {
        const ifd0 = structure.ifd0;
        const exifEntry = getExifEntry(ifd0, 0x8769);

        if (options.stripGps) {
            ifd0.entries = ifd0.entries.filter((entry) => entry.tag !== 0x8825);
        }

        if (exifEntry && exifEntry.childIfd && options.stripMakerNote) {
            exifEntry.childIfd.entries = exifEntry.childIfd.entries.filter((entry) => entry.tag !== 0x927C);
            sanitizeIfdEntries(exifEntry.childIfd);
            if (exifEntry.childIfd.entries.length === 0) {
                ifd0.entries = ifd0.entries.filter((entry) => entry.tag !== 0x8769);
            }
        }

        if (options.stripThumbnail) {
            ifd0.nextIfd = null;
        } else if (ifd0.nextIfd && !ifd0.nextIfd.thumbnailData) {
            ifd0.nextIfd = null;
        }

        sanitizeIfdEntries(ifd0);
        return structure;
    }

    function buildExifInlineValue(entry) {
        if (entry.byteLength === 0) {
            return new Uint8Array(4);
        }
        return padBytes(entry.dataBytes || entry.inlineValue || new Uint8Array(0), 4);
    }

    function buildExifIfd(ifd, writer) {
        const ifdOffset = writer.tell();
        const entries = ifd.entries.slice();
        const entryCount = entries.length;
        const tableStart = ifdOffset;
        const tableSize = 2 + entryCount * 12 + 4;

        writer.ensure(tableSize);
        writer.patchUint16(tableStart, entryCount);
        writer.seek(tableStart + tableSize);

        const writeEntryValue = (rowOffset, entry) => {
            if (ifd.thumbnailData && entry.tag === 0x0201 && ifd.thumbnailMode === 'jpeg') {
                if (!ifd._thumbnailOffset) {
                    writer.align(2);
                    ifd._thumbnailOffset = writer.tell();
                    writer.writeBytes(ifd.thumbnailData);
                    writer.align(2);
                }
                writer.patchUint32(rowOffset + 8, ifd._thumbnailOffset);
                return;
            }

            if (ifd.thumbnailData && entry.tag === 0x0202 && ifd.thumbnailMode === 'jpeg') {
                writer.patchUint32(rowOffset + 8, ifd.thumbnailData.length);
                return;
            }

            if (ifd.thumbnailData && entry.tag === 0x0111 && ifd.thumbnailMode === 'strip' && entry.count === 1) {
                if (!ifd._thumbnailOffset) {
                    writer.align(2);
                    ifd._thumbnailOffset = writer.tell();
                    writer.writeBytes(ifd.thumbnailData);
                    writer.align(2);
                }
                writer.patchUint32(rowOffset + 8, ifd._thumbnailOffset);
                return;
            }

            if (ifd.thumbnailData && entry.tag === 0x0117 && ifd.thumbnailMode === 'strip' && entry.count === 1) {
                writer.patchUint32(rowOffset + 8, ifd.thumbnailData.length);
                return;
            }

            if ((entry.tag === 0x8769 || entry.tag === 0x8825 || entry.tag === 0xA005) && entry.childIfd) {
                writer.align(2);
                const childOffset = writer.tell();
                buildExifIfd(entry.childIfd, writer);
                writer.patchUint32(rowOffset + 8, childOffset);
                return;
            }

            if (entry.byteLength <= 4) {
                writer.patchBytes(rowOffset + 8, buildExifInlineValue(entry));
                return;
            }

            if (!entry.dataBytes) {
                writer.patchUint32(rowOffset + 8, 0);
                return;
            }

            writer.align(2);
            const dataOffset = writer.tell();
            writer.writeBytes(entry.dataBytes);
            writer.align(2);
            writer.patchUint32(rowOffset + 8, dataOffset);
        };

        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            const rowOffset = tableStart + 2 + index * 12;
            writer.patchUint16(rowOffset, entry.tag);
            writer.patchUint16(rowOffset + 2, entry.type);
            writer.patchUint32(rowOffset + 4, entry.count);
            writeEntryValue(rowOffset, entry);
        }

        let nextOffset = 0;
        if (ifd.nextIfd) {
            writer.align(2);
            nextOffset = writer.tell();
            buildExifIfd(ifd.nextIfd, writer);
        }

        writer.patchUint32(tableStart + 2 + entryCount * 12, nextOffset);
    }

    function buildExifData(structure) {
        const writer = new BinaryWriter(structure.littleEndian, 1024);
        if (structure.littleEndian) {
            writer.writeUint8(0x49);
            writer.writeUint8(0x49);
        } else {
            writer.writeUint8(0x4D);
            writer.writeUint8(0x4D);
        }
        writer.writeUint16(42);
        writer.writeUint32(8);
        writer.seek(8);
        buildExifIfd(structure.ifd0, writer);
        return writer.toUint8Array();
    }

    function filterExifTiff(bytes, options) {
        if (options.stripExif) {
            return null;
        }
        if (!options.stripGps && !options.stripMakerNote && !options.stripThumbnail) {
            return bytes;
        }

        const structure = parseExifStructure(bytes);
        if (!structure) {
            return bytes;
        }

        applyExifFilters(structure, options);
        return buildExifData(structure);
    }

    function parsePhotoshopIRB(data) {
        const info = {
            hasIptc: false,
            has8bim: false,
            hasExif: false,
            layers: 0
        };

        if (!data || data.length < 14) {
            return info;
        }

        let offset = startsWithBytes(data, PHOTOSHOP_PREFIX) ? PHOTOSHOP_PREFIX.length : 0;

        while (offset + 12 <= data.length) {
            const sig = asciiString(data, offset, offset + 4);
            if (sig !== '8BIM') {
                offset += 1;
                continue;
            }

            info.has8bim = true;
            const resourceId = (data[offset + 4] << 8) | data[offset + 5];
            const nameLength = data[offset + 6] || 0;
            const paddedNameLength = (1 + nameLength + 1) & ~1;
            const dataSizeOffset = offset + 6 + paddedNameLength;
            if (dataSizeOffset + 4 > data.length) {
                break;
            }

            const dataSize =
                ((data[dataSizeOffset] << 24) >>> 0) |
                (data[dataSizeOffset + 1] << 16) |
                (data[dataSizeOffset + 2] << 8) |
                data[dataSizeOffset + 3];

            if (resourceId === 0x0404) {
                info.hasIptc = true;
            }
            if (resourceId === 0x0422) {
                info.hasExif = true;
            }
            if (resourceId === 0x03E8) {
                info.layers += 1;
            }

            offset = dataSizeOffset + 4 + dataSize + (dataSize % 2);
        }

        return info;
    }

    function parsePhotoshopBlocks(payload) {
        const blocks = [];
        let offset = startsWithBytes(payload, PHOTOSHOP_PREFIX) ? PHOTOSHOP_PREFIX.length : 0;
        const prefix = payload.slice(0, offset);

        while (offset + 12 <= payload.length) {
            const sig = asciiString(payload, offset, offset + 4);
            if (sig !== '8BIM') {
                offset += 1;
                continue;
            }

            const id = (payload[offset + 4] << 8) | payload[offset + 5];
            const nameLength = payload[offset + 6] || 0;
            const paddedNameLength = (1 + nameLength + 1) & ~1;
            const nameField = payload.slice(offset + 6, offset + 6 + paddedNameLength);
            const dataSizeOffset = offset + 6 + paddedNameLength;
            if (dataSizeOffset + 4 > payload.length) {
                break;
            }

            const dataSize =
                ((payload[dataSizeOffset] << 24) >>> 0) |
                (payload[dataSizeOffset + 1] << 16) |
                (payload[dataSizeOffset + 2] << 8) |
                payload[dataSizeOffset + 3];
            const dataStart = dataSizeOffset + 4;
            const dataEnd = dataStart + dataSize;
            if (dataEnd > payload.length) {
                break;
            }

            blocks.push({
                id,
                nameField,
                data: payload.slice(dataStart, dataEnd)
            });

            offset = dataEnd + (dataSize % 2);
        }

        return { prefix, blocks };
    }

    function buildPhotoshopPayload(prefix, blocks) {
        const chunks = [prefix.length ? prefix : PHOTOSHOP_PREFIX];
        for (const block of blocks) {
            const sizeBytes = new Uint8Array(4);
            const view = new DataView(sizeBytes.buffer);
            view.setUint32(0, block.data.length, false);
            chunks.push(Uint8Array.from([0x38, 0x42, 0x49, 0x4D]));
            chunks.push(Uint8Array.from([(block.id >> 8) & 0xFF, block.id & 0xFF]));
            chunks.push(block.nameField.length ? block.nameField : Uint8Array.from([0x00, 0x00]));
            chunks.push(sizeBytes);
            chunks.push(block.data);
            if (block.data.length % 2 === 1) {
                chunks.push(Uint8Array.from([0x00]));
            }
        }
        return concatBytes(chunks);
    }

    function filterPhotoshopPayload(payload, options) {
        const parsed = parsePhotoshopBlocks(payload);
        const shouldRemoveExifResource = Boolean(
            options.stripExif || options.stripGps || options.stripMakerNote || options.stripThumbnail
        );
        const keptBlocks = parsed.blocks.filter((block) => {
            if (options.stripIptc && block.id === 0x0404) {
                return false;
            }
            if (shouldRemoveExifResource && block.id === 0x0422) {
                return false;
            }
            return true;
        });

        if (keptBlocks.length === parsed.blocks.length) {
            return payload;
        }
        if (keptBlocks.length === 0) {
            return null;
        }
        return buildPhotoshopPayload(parsed.prefix, keptBlocks);
    }

    function parseJpegSegments(bytes) {
        if (!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
            return null;
        }

        const segments = [];
        let offset = 2;

        while (offset < bytes.length) {
            if (bytes[offset] !== 0xFF) {
                offset += 1;
                continue;
            }

            const markerStart = offset;
            while (offset < bytes.length && bytes[offset] === 0xFF) {
                offset += 1;
            }
            if (offset >= bytes.length) {
                break;
            }

            const marker = bytes[offset];
            offset += 1;

            if (marker === 0xD9 || marker === 0xDA) {
                return { segments, tail: bytes.slice(markerStart) };
            }

            if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
                segments.push({ marker, payload: new Uint8Array(0) });
                continue;
            }

            if (offset + 1 >= bytes.length) {
                return null;
            }

            const length = (bytes[offset] << 8) | bytes[offset + 1];
            if (length < 2 || offset + length > bytes.length) {
                return null;
            }

            segments.push({
                marker,
                payload: bytes.slice(offset + 2, offset + length)
            });
            offset += length;
        }

        return { segments, tail: new Uint8Array(0) };
    }

    function buildJpegSegment(marker, payload) {
        if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
            return Uint8Array.from([0xFF, marker]);
        }

        const length = payload.length + 2;
        const out = new Uint8Array(length + 2);
        out[0] = 0xFF;
        out[1] = marker;
        out[2] = (length >> 8) & 0xFF;
        out[3] = length & 0xFF;
        out.set(payload, 4);
        return out;
    }

    function getJpegSegmentKind(segment) {
        const marker = segment.marker;
        const payload = segment.payload;

        if (marker === 0xE0 && startsWithBytes(payload, Uint8Array.from([0x4A, 0x46, 0x49, 0x46, 0x00]))) {
            return 'jfif';
        }

        if (marker === 0xE1) {
            if (startsWithBytes(payload, EXIF_PREFIX)) {
                return 'exif';
            }

            const header = asciiString(payload, 0, Math.min(payload.length, 48));
            if (
                header.startsWith(XMP_JPEG_PREFIX) ||
                header.startsWith(XMP_JPEG_EXTENDED_PREFIX) ||
                header.startsWith('http://ns.adobe.com/xmp/') ||
                header.startsWith('<x:xmpmeta') ||
                header.startsWith('<?xpacket')
            ) {
                return 'xmp';
            }
        }

        if (marker === 0xE2) {
            if (startsWithBytes(payload, ICC_PREFIX)) {
                return 'icc';
            }
            if (asciiString(payload, 0, Math.min(payload.length, 16)).startsWith('FPXR')) {
                return 'flashpix';
            }
            if (asciiString(payload, 0, Math.min(payload.length, 16)).startsWith('PrintIM')) {
                return 'printim';
            }
        }

        if (marker === 0xED && asciiString(payload, 0, Math.min(payload.length, 14)).startsWith('Photoshop')) {
            return 'photoshop';
        }

        if (marker === 0xFE) {
            return 'comment';
        }

        return '';
    }

    function detectMetadataFromJpeg(bytes) {
        const parsed = parseJpegSegments(bytes);
        if (!parsed) {
            return [];
        }

        const detected = [];
        for (const segment of parsed.segments) {
            const kind = getJpegSegmentKind(segment);
            if (kind === 'jfif') {
                detected.push({ type: 'JFIF' });
            } else if (kind === 'exif') {
                detected.push({ type: 'EXIF', details: parseExifDetails(segment.payload.slice(EXIF_PREFIX.length)) });
            } else if (kind === 'xmp') {
                detected.push({ type: 'XMP' });
            } else if (kind === 'icc') {
                detected.push({ type: 'ICC Profile' });
            } else if (kind === 'flashpix') {
                detected.push({ type: 'FlashPix' });
            } else if (kind === 'printim') {
                detected.push({ type: 'PrintIM' });
            } else if (kind === 'photoshop') {
                const info = parsePhotoshopIRB(segment.payload);
                detected.push({ type: 'Photoshop IRB', details: info });
                if (info.hasIptc) {
                    detected.push({ type: 'IPTC' });
                }
            } else if (kind === 'comment') {
                detected.push({ type: 'Comment' });
            }
        }

        return detected;
    }

    function stripJpegLossless(bytes, options) {
        const parsed = parseJpegSegments(bytes);
        if (!parsed) {
            throw new Error('Invalid JPEG file');
        }

        const outputSegments = [];
        for (const segment of parsed.segments) {
            const kind = getJpegSegmentKind(segment);

            if (kind === 'jfif' && options.stripJfif) {
                continue;
            }
            if (kind === 'xmp' && options.stripXmp) {
                continue;
            }
            if (kind === 'icc' && options.stripIcc) {
                continue;
            }
            if (kind === 'flashpix' && options.stripFlashPix) {
                continue;
            }
            if (kind === 'printim' && options.stripPrintIm) {
                continue;
            }
            if (kind === 'comment' && options.stripComment) {
                continue;
            }
            if (kind === 'photoshop') {
                if (options.stripPhotoshop) {
                    continue;
                }
                const filteredPayload = filterPhotoshopPayload(segment.payload, options);
                if (!filteredPayload) {
                    continue;
                }
                outputSegments.push(buildJpegSegment(segment.marker, filteredPayload));
                continue;
            }
            if (kind === 'exif') {
                const filteredExif = filterExifTiff(segment.payload.slice(EXIF_PREFIX.length), options);
                if (!filteredExif) {
                    continue;
                }
                outputSegments.push(buildJpegSegment(segment.marker, concatBytes([EXIF_PREFIX, filteredExif])));
                continue;
            }

            outputSegments.push(buildJpegSegment(segment.marker, segment.payload));
        }

        return concatBytes([JPEG_SOI, ...outputSegments, parsed.tail]);
    }

    function parsePngChunks(bytes) {
        if (!bytes || bytes.length < 8 || !startsWithBytes(bytes, PNG_SIGNATURE)) {
            return null;
        }

        const chunks = [];
        let offset = 8;

        while (offset + 12 <= bytes.length) {
            const length =
                ((bytes[offset] << 24) >>> 0) |
                (bytes[offset + 1] << 16) |
                (bytes[offset + 2] << 8) |
                bytes[offset + 3];
            const type = asciiString(bytes, offset + 4, offset + 8);
            const chunkEnd = offset + 12 + length;
            if (chunkEnd > bytes.length) {
                return null;
            }

            chunks.push({
                type,
                payload: bytes.slice(offset + 8, offset + 8 + length),
                raw: bytes.slice(offset, chunkEnd)
            });

            offset = chunkEnd;
            if (type === 'IEND') {
                break;
            }
        }

        return chunks;
    }

    const CRC_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n += 1) {
            let crc = n;
            for (let bit = 0; bit < 8; bit += 1) {
                crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
            }
            table[n] = crc >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i += 1) {
            crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function buildPngChunk(type, payload) {
        const typeBytes = Uint8Array.from(type.split('').map((char) => char.charCodeAt(0)));
        const lengthBytes = new Uint8Array(4);
        const lengthView = new DataView(lengthBytes.buffer);
        lengthView.setUint32(0, payload.length >>> 0, false);
        const crcBytes = new Uint8Array(4);
        const crcView = new DataView(crcBytes.buffer);
        crcView.setUint32(0, crc32(concatBytes([typeBytes, payload])), false);
        return concatBytes([lengthBytes, typeBytes, payload, crcBytes]);
    }

    function getPngTextKeyword(chunk) {
        let offset = 0;
        while (offset < chunk.payload.length && chunk.payload[offset] !== 0) {
            offset += 1;
        }
        return asciiString(chunk.payload, 0, offset);
    }

    function getPngChunkKind(chunk) {
        if (chunk.type === 'eXIf') {
            return 'exif';
        }
        if (chunk.type === 'iCCP') {
            return 'icc';
        }
        if (chunk.type === 'iTXt' || chunk.type === 'tEXt' || chunk.type === 'zTXt') {
            const keyword = getPngTextKeyword(chunk);
            if (keyword === 'XML:com.adobe.xmp' || keyword === 'Raw profile type xmp') {
                return 'xmp';
            }
            if (keyword === 'Raw profile type iptc') {
                return 'iptc';
            }
            if (keyword === 'PrintIM') {
                return 'printim';
            }
            if (COMMENT_KEYWORDS.has(keyword.toLowerCase())) {
                return 'comment';
            }
            return 'text';
        }
        return '';
    }

    function detectMetadataFromPng(bytes) {
        const chunks = parsePngChunks(bytes);
        if (!chunks) {
            return [];
        }

        const detected = [];
        for (const chunk of chunks) {
            const kind = getPngChunkKind(chunk);
            if (kind === 'exif') {
                detected.push({ type: 'EXIF', details: parseExifDetails(chunk.payload) });
            } else if (kind === 'xmp') {
                detected.push({ type: 'XMP' });
            } else if (kind === 'iptc') {
                detected.push({ type: 'IPTC' });
            } else if (kind === 'printim') {
                detected.push({ type: 'PrintIM' });
            } else if (kind === 'comment') {
                detected.push({ type: 'Comment' });
            } else if (kind === 'icc') {
                detected.push({ type: 'ICC Profile' });
            }
        }
        return detected;
    }

    function stripPngLossless(bytes, options) {
        const chunks = parsePngChunks(bytes);
        if (!chunks) {
            throw new Error('Invalid PNG file');
        }

        const outputChunks = [PNG_SIGNATURE];
        for (const chunk of chunks) {
            const kind = getPngChunkKind(chunk);
            if (kind === 'exif') {
                const filteredExif = filterExifTiff(chunk.payload, options);
                if (!filteredExif) {
                    continue;
                }
                outputChunks.push(
                    bytesEqual(filteredExif, chunk.payload) ? chunk.raw : buildPngChunk(chunk.type, filteredExif)
                );
                continue;
            }
            if (kind === 'xmp' && options.stripXmp) {
                continue;
            }
            if (kind === 'iptc' && options.stripIptc) {
                continue;
            }
            if (kind === 'printim' && options.stripPrintIm) {
                continue;
            }
            if (kind === 'comment' && options.stripComment) {
                continue;
            }
            if (kind === 'icc' && options.stripIcc) {
                continue;
            }
            outputChunks.push(chunk.raw);
        }

        return concatBytes(outputChunks);
    }

    function parseWebpChunks(bytes) {
        if (
            !bytes ||
            bytes.length < 12 ||
            asciiString(bytes, 0, 4) !== 'RIFF' ||
            asciiString(bytes, 8, 12) !== 'WEBP'
        ) {
            return null;
        }

        const chunks = [];
        let offset = 12;

        while (offset + 8 <= bytes.length) {
            const type = asciiString(bytes, offset, offset + 4);
            const size =
                bytes[offset + 4] |
                (bytes[offset + 5] << 8) |
                (bytes[offset + 6] << 16) |
                ((bytes[offset + 7] << 24) >>> 0);
            const dataStart = offset + 8;
            const dataEnd = dataStart + size;
            const paddedEnd = dataEnd + (size & 1);
            if (paddedEnd > bytes.length) {
                return null;
            }

            chunks.push({
                type,
                payload: bytes.slice(dataStart, dataEnd),
                raw: bytes.slice(offset, paddedEnd)
            });
            offset = paddedEnd;
        }

        return chunks;
    }

    function buildWebpChunk(type, payload) {
        const typeBytes = Uint8Array.from(type.split('').map((char) => char.charCodeAt(0)));
        const sizeBytes = new Uint8Array(4);
        const view = new DataView(sizeBytes.buffer);
        view.setUint32(0, payload.length >>> 0, true);
        const padding = payload.length & 1 ? Uint8Array.from([0x00]) : new Uint8Array(0);
        return concatBytes([typeBytes, sizeBytes, payload, padding]);
    }

    function getWebpChunkKind(chunk) {
        if (chunk.type === 'EXIF') {
            return 'exif';
        }
        if (chunk.type === 'XMP ') {
            return 'xmp';
        }
        if (chunk.type === 'ICCP') {
            return 'icc';
        }
        return '';
    }

    function updateVp8xFlags(payload, keptKinds) {
        if (!payload || payload.length < 10) {
            return payload;
        }
        const out = payload.slice();
        out[0] &= ~(0x20 | 0x08 | 0x04);
        if (keptKinds.has('icc')) {
            out[0] |= 0x20;
        }
        if (keptKinds.has('exif')) {
            out[0] |= 0x08;
        }
        if (keptKinds.has('xmp')) {
            out[0] |= 0x04;
        }
        return out;
    }

    function detectMetadataFromWebp(bytes) {
        const chunks = parseWebpChunks(bytes);
        if (!chunks) {
            return [];
        }

        const detected = [];
        for (const chunk of chunks) {
            const kind = getWebpChunkKind(chunk);
            if (kind === 'exif') {
                detected.push({ type: 'EXIF', details: parseExifDetails(chunk.payload) });
            } else if (kind === 'xmp') {
                detected.push({ type: 'XMP' });
            } else if (kind === 'icc') {
                detected.push({ type: 'ICC Profile' });
            }
        }
        return detected;
    }

    function stripWebpLossless(bytes, options) {
        const chunks = parseWebpChunks(bytes);
        if (!chunks) {
            throw new Error('Invalid WebP file');
        }

        const keptKinds = new Set();
        const processedChunks = new Array(chunks.length).fill(null);

        for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            const kind = getWebpChunkKind(chunk);
            if (chunk.type === 'VP8X') {
                continue;
            }
            if (kind === 'exif') {
                const filteredExif = filterExifTiff(chunk.payload, options);
                if (!filteredExif) {
                    continue;
                }
                keptKinds.add('exif');
                processedChunks[index] =
                    bytesEqual(filteredExif, chunk.payload) ? chunk.raw : buildWebpChunk(chunk.type, filteredExif)
                ;
                continue;
            }
            if (kind === 'xmp') {
                if (options.stripXmp) {
                    continue;
                }
                keptKinds.add('xmp');
                processedChunks[index] = chunk.raw;
                continue;
            }
            if (kind === 'icc') {
                if (options.stripIcc) {
                    continue;
                }
                keptKinds.add('icc');
                processedChunks[index] = chunk.raw;
                continue;
            }
            processedChunks[index] = chunk.raw;
        }

        const finalChunks = [];
        for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            if (chunk.type === 'VP8X') {
                finalChunks.push(buildWebpChunk(chunk.type, updateVp8xFlags(chunk.payload, keptKinds)));
                continue;
            }
            if (processedChunks[index]) {
                finalChunks.push(processedChunks[index]);
            }
        }

        const body = concatBytes(finalChunks);
        const header = new Uint8Array(12);
        header.set(Uint8Array.from([0x52, 0x49, 0x46, 0x46]), 0);
        const view = new DataView(header.buffer);
        view.setUint32(4, body.length + 4, true);
        header.set(Uint8Array.from([0x57, 0x45, 0x42, 0x50]), 8);
        return concatBytes([header, body]);
    }

    function detectMetadata(uint8, mimeType) {
        const normalizedMimeType = normalizeMimeType(mimeType, uint8);
        if (normalizedMimeType === 'image/jpeg') {
            return detectMetadataFromJpeg(uint8);
        }
        if (normalizedMimeType === 'image/png') {
            return detectMetadataFromPng(uint8);
        }
        if (normalizedMimeType === 'image/webp') {
            return detectMetadataFromWebp(uint8);
        }
        return [];
    }

    function stripMetadataLossless(uint8, mimeType, options) {
        const normalizedMimeType = normalizeMimeType(mimeType, uint8);
        if (!normalizedMimeType) {
            throw new Error('Unsupported image format');
        }
        if (normalizedMimeType === 'image/jpeg') {
            return stripJpegLossless(uint8, options);
        }
        if (normalizedMimeType === 'image/png') {
            return stripPngLossless(uint8, options);
        }
        if (normalizedMimeType === 'image/webp') {
            return stripWebpLossless(uint8, options);
        }
        throw new Error('Unsupported image format');
    }

    const api = {
        ACCEPT_ATTRIBUTE,
        SUPPORTED_MIME_TYPES,
        detectMimeType,
        validateFileType,
        detectMetadata,
        parseExifDetails,
        parsePhotoshopIRB,
        stripMetadataLossless
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    globalScope.MetadataCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
