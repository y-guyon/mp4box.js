import { Box } from '#/box';
import type { MultiBufferStream } from '#/buffer';

export class hrsdBox extends Box {
  static override readonly fourcc = 'hrsd' as const;
  box_name = 'HumanReadableStreamDescriptionBox' as const;

  description: string;

  parse(stream: MultiBufferStream) {
    this.description = stream.readCString();
  }
}
