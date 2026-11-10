import { Box } from '#/box';
import type { MultiBufferStream } from '#/buffer';
import { Log } from '#/log';

const OBU_TYPE_NAMES: Record<number, string> = {
  1: 'OBU_SEQUENCE_HEADER',
  2: 'OBU_TEMPORAL_DELIMITER',
  3: 'OBU_MULTI_FRAME_HEADER',
  4: 'OBU_CLOSED_LOOP_KEY',
  5: 'OBU_OPEN_LOOP_KEY',
  6: 'OBU_LEADING_TILE_GROUP',
  7: 'OBU_REGULAR_TILE_GROUP',
  8: 'OBU_METADATA_SHORT',
  9: 'OBU_METADATA_GROUP',
  10: 'OBU_SWITCH',
  11: 'OBU_LEADING_SEF',
  12: 'OBU_REGULAR_SEF',
  13: 'OBU_LEADING_TIP',
  14: 'OBU_REGULAR_TIP',
  15: 'OBU_BUFFER_REMOVAL_TIMING',
  16: 'OBU_LAYER_CONFIGURATION_RECORD',
  17: 'OBU_ATLAS_SEGMENT',
  18: 'OBU_OPERATING_POINT_SET',
  19: 'OBU_BRIDGE_FRAME',
  20: 'OBU_MSDO',
  21: 'OBU_RAS_FRAME',
  22: 'OBU_QUANTIZATION_MATRIX',
  23: 'OBU_FILM_GRAIN',
  24: 'OBU_CONTENT_INTERPRETATION',
  25: 'OBU_PADDING',
};

class av2CConfigOBU extends Box {
  obu_size: number;
  obu_extension_flag: number;
  obu_type: number;
  obu_type_name: string;
  obu_tlayer_id: number;
  obu_mlayer_id?: number;
  obu_xlayer_id?: number;
  seq_header_id?: number;
  seq_profile_idc?: number;
  single_picture_header_flag?: boolean;
  seq_level_idx?: number;
  seq_tier?: number;
  chroma_format_idc?: number;
  bit_depth_idc?: number;
}

function readLeb128(stream: MultiBufferStream, endPos: number): number {
  let value = 0;
  for (let i = 0; i < 8 && stream.getPosition() < endPos; i++) {
    const byte = stream.readUint8();
    value |= (byte & 0x7f) << (i * 7);
    if ((byte & 0x80) === 0) {
      break;
    }
  }
  return value >>> 0;
}

export class av2CBox extends Box {
  static override readonly fourcc = 'av2C' as const;
  box_name = 'OutOfBandAV2CodecConfigurationBox' as const;

  reserved1: number;
  config_obus_count_minus1: number;
  config_obus: Uint8Array;
  entries?: Array<av2CConfigOBU>;

  parse(stream: MultiBufferStream) {
    const boxEnd = this.start + this.size;
    stream.enterBitMode();
    this.reserved1 = stream.readBits(7);
    this.config_obus_count_minus1 = stream.readBits(9);
    stream.exitBitMode();

    if (this.reserved1 !== 0) {
      Log.error('BoxParser', 'av2C reserved1 parsing problem', stream.isofile);
    }

    const obusStart = stream.getPosition();
    const obusLength = Math.max(0, boxEnd - obusStart);
    this.config_obus = stream.readUint8Array(obusLength);
    stream.seek(obusStart);

    const count = this.config_obus_count_minus1 + 1;
    for (let i = 0; i < count && stream.getPosition() < boxEnd; i++) {
      const obuStart = stream.getPosition();
      const obu_size = readLeb128(stream, boxEnd);
      const sizeFieldLen = stream.getPosition() - obuStart;
      const obuEnd = Math.min(boxEnd, stream.getPosition() + obu_size);

      const entry = new av2CConfigOBU(sizeFieldLen + obu_size);
      entry.start = obuStart;
      entry.hdr_size = sizeFieldLen;
      entry.obu_size = obu_size;

      if (stream.getPosition() < obuEnd) {
        const hdrByte1 = stream.readUint8();
        entry.obu_extension_flag = (hdrByte1 >> 7) & 0x1;
        entry.obu_type = (hdrByte1 >> 2) & 0x1f;
        entry.obu_type_name = OBU_TYPE_NAMES[entry.obu_type] ?? `OBU_TYPE_${entry.obu_type}`;
        entry.type = entry.obu_type_name;
        entry.box_name = entry.obu_type_name;
        entry.obu_tlayer_id = hdrByte1 & 0x3;

        if (entry.obu_extension_flag === 1 && stream.getPosition() < obuEnd) {
          const hdrByte2 = stream.readUint8();
          entry.obu_mlayer_id = (hdrByte2 >> 5) & 0x7;
          entry.obu_xlayer_id = hdrByte2 & 0x1f;
        }

        const payloadStart = stream.getPosition();
        const payloadLen = Math.max(0, obuEnd - payloadStart);
        entry.data = stream.readUint8Array(payloadLen);

        if (entry.obu_type === 1 && payloadLen > 0) {
          stream.seek(payloadStart);
          try {
            stream.enterBitMode();
            entry.seq_header_id = stream.readUE();
            entry.seq_profile_idc = stream.readBits(5);
            entry.single_picture_header_flag = stream.readFlag();
            entry.seq_level_idx = stream.readBits(5);
            if (entry.seq_level_idx > 3 && !entry.single_picture_header_flag) {
              entry.seq_tier = stream.readBits(1);
            } else {
              entry.seq_tier = 0;
            }
            entry.chroma_format_idc = stream.readUE();
            entry.bit_depth_idc = stream.readUE();
          } catch {
            // Ignore partial SequenceHeaderOBU parse errors in truncated inputs.
          } finally {
            while (stream.inBitMode) {
              stream.exitBitMode(false);
            }
          }
        }
      }

      stream.seek(obuEnd);
      this.addEntry(entry);
    }

    stream.seek(boxEnd);
  }
}

export class av2cBox extends Box {
  static override readonly fourcc = 'av2c' as const;
  box_name = 'InBandAV2CodecConfigurationBox' as const;

  max_num_streams_minus1: number;
  max_profile_idc: number;
  max_level_idx: number;
  max_tier: number;
  max_bit_depth_idc: number;

  parse(stream: MultiBufferStream) {
    stream.enterBitMode();
    this.max_num_streams_minus1 = stream.readBits(2);
    this.max_profile_idc = stream.readBits(5);
    this.max_level_idx = stream.readBits(5);
    this.max_tier = stream.readBits(1);
    this.max_bit_depth_idc = stream.readBits(3);
    stream.exitBitMode();
  }
}
