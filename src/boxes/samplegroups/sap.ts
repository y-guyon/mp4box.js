import { SampleGroupEntry } from '#/box';
import type { MultiBufferStream } from '#/buffer';

export class sapSampleGroupEntry extends SampleGroupEntry {
  static grouping_type = 'sap ' as const;

  dependent_flag: number;
  reserved: number;
  SAP_type: number;

  parse(stream: MultiBufferStream) {
    const tmp_byte = stream.readUint8();
    this.dependent_flag = (tmp_byte >> 7) & 0x1;
    this.reserved = (tmp_byte >> 4) & 0x7;
    this.SAP_type = tmp_byte & 0xf;
  }
}
