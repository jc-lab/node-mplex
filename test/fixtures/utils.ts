import { concat as uint8ArrayConcat } from 'uint8arrays/concat'
import { Message, MessageTypes } from '../../src/message-types'
import {Encoder} from "../../src/encode";
import {Decoder} from "../../src/decode";

export function messageWithBytes (msg: Message) {
  if (msg.type === MessageTypes.NEW_STREAM || msg.type === MessageTypes.MESSAGE_INITIATOR || msg.type === MessageTypes.MESSAGE_RECEIVER) {
    return {
      ...msg,
      data: msg.data.slice() // convert Uint8ArrayList to Buffer
    }
  }

  return msg
}

export function encode(source: Message[]): Uint8Array[] {
  const encoder = new Encoder();
  return source.map((msg) => uint8ArrayConcat(encoder.write(msg)));
}

export function decode(source: Uint8Array[]): Message[][] {
  const decoder = new Decoder();
  return source.map(v => decoder.write(v));
}

export function all<T>(input: T[]): T[] {
  return input;
}
