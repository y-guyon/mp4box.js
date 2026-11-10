import { FullBox } from '#/box';
import type { MultiBufferStream } from '#/buffer';

export interface LayerPropertyAssociation {
  target_id: number;
  props: Array<{
    reserved: number;
    source: number;
    property_index?: number;
    property_4cc?: string;
  }>;
}

export class lpmaBox extends FullBox {
  static override readonly fourcc = 'lpma' as const;
  box_name = 'LayerPropertyAssociationBox' as const;

  target_type: number;
  associations: Array<LayerPropertyAssociation>;

  parse(stream: MultiBufferStream) {
    this.parseFullHeader(stream);
    this.target_type = this.flags & 0x1;
    const entry_count = stream.readUint32();
    this.associations = [];
    for (let i = 0; i < entry_count; i++) {
      const target_id = stream.readUint32();
      const association_count = stream.readUint8();
      const props = [];
      for (let j = 0; j < association_count; j++) {
        const tmp = stream.readUint8();
        const reserved = (tmp >> 1) & 0x7f;
        const source = tmp & 0x1;
        if (source === 0) {
          props.push({
            reserved,
            source,
            property_index: stream.readUint16(),
          });
        } else {
          props.push({
            reserved,
            source,
            property_4cc: stream.readString(4),
          });
        }
      }
      this.associations.push({
        target_id,
        props,
      });
    }
  }
}
