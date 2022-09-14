import * as streams from 'stream'
import { Encoder } from './encode'
import { Decoder } from './decode'
import { MessageTypes, MessageTypeNames, Message } from './message-types'
import { MplexStream, createStream } from './stream'
import { toString as uint8ArrayToString } from 'uint8arrays'
import errCode from 'err-code'
import { RateLimiterMemory } from 'rate-limiter-flexible'
import type { Logger, LoggerFactory } from './logger'
import { dummyLogger } from './logger'
import type { Stream, StreamMuxer, StreamMuxerInit } from './types'

export interface MplexInit {
  loggerFactory?: LoggerFactory

  /**
   * The maximum size of message that can be sent in one go in bytes.
   * Messages larger than this will be split into multiple smaller
   * messages (default: 1MB)
   */
  maxMsgSize?: number

  /**
   * The maximum number of multiplexed streams that can be open at any
   * one time. A request to open more than this will have a stream
   * reset message sent immediately as a response for the newly opened
   * stream id (default: 1024)
   */
  maxInboundStreams?: number

  /**
   * The maximum number of multiplexed streams that can be open at any
   * one time. An attempt to open more than this will throw (default: 1024)
   */
  maxOutboundStreams?: number

  /**
   * Incoming stream messages are buffered until processed by the stream
   * handler. If the buffer reaches this size in bytes the stream will
   * be reset (default: 4MB)
   */
  maxStreamBufferSize?: number

  /**
   * When `maxInboundStreams` is hit, if the remote continues try to open
   * more than this many new multiplexed streams per second the connection
   * will be closed (default: 5)
   */
  disconnectThreshold?: number
}

const MAX_STREAMS_INBOUND_STREAMS_PER_CONNECTION = 1024
const MAX_STREAMS_OUTBOUND_STREAMS_PER_CONNECTION = 1024
const MAX_STREAM_BUFFER_SIZE = 1024 * 1024 * 4 // 4MB
const DISCONNECT_THRESHOLD = 5

function printMessage (msg: Message) {
  const output: any = {
    ...msg,
    type: `${MessageTypeNames[msg.type]} (${msg.type})`
  }

  if (msg.type === MessageTypes.NEW_STREAM) {
    output.data = uint8ArrayToString(msg.data instanceof Uint8Array ? msg.data : msg.data.subarray())
  }

  if (msg.type === MessageTypes.MESSAGE_INITIATOR || msg.type === MessageTypes.MESSAGE_RECEIVER) {
    output.data = uint8ArrayToString(msg.data instanceof Uint8Array ? msg.data : msg.data.subarray(), 'base16')
  }

  return output
}

export interface MplexStreamMuxerInit extends MplexInit, StreamMuxerInit {}

export class MplexStreamMuxer extends streams.Duplex implements StreamMuxer {
  private readonly log: Logger

  private readonly encoder = new Encoder()
  private readonly decoder = new Decoder()

  private _streamId: number
  private readonly _streams: { initiators: Map<number, MplexStream>, receivers: Map<number, MplexStream> }
  private readonly _init: MplexStreamMuxerInit
  private readonly closeController: AbortController
  private readonly rateLimiter: RateLimiterMemory

  constructor (init?: Partial<MplexStreamMuxerInit>) {
    super({
      autoDestroy: true
    })

    init = init ?? {} as any

    this.log = ((init?.loggerFactory) != null) ? init?.loggerFactory('mplex') : dummyLogger()

    this._streamId = 0
    this._streams = {
      /**
       * Stream to ids map
       */
      initiators: new Map<number, MplexStream>(),
      /**
       * Stream to ids map
       */
      receivers: new Map<number, MplexStream>()
    }
    this._init = init as any

    /**
     * Close controller
     */
    this.closeController = new AbortController()

    this.rateLimiter = new RateLimiterMemory({
      points: init?.disconnectThreshold ?? DISCONNECT_THRESHOLD,
      duration: 1
    })
  }

  /**
   * Returns a Map of streams and their ids
   */
  get streams () {
    // Inbound and Outbound streams may have the same ids, so we need to make those unique
    const streams: Stream[] = []
    this._streams.initiators.forEach((stream) => {
      streams.push(stream)
    })
    this._streams.receivers.forEach((stream) => {
      streams.push(stream)
    })
    return streams
  }

  /**
   * Initiate a new stream with the given name. If no name is
   * provided, the id of the stream will be used.
   */
  newStream (name?: string): MplexStream {
    if (this.closeController.signal.aborted) {
      throw new Error('Muxer already closed')
    }
    const id = this._streamId++
    name = name == null ? id.toString() : name.toString()
    const registry = this._streams.initiators
    return this._newStream({ id, name, type: 'initiator', registry })
  }

  /**
   * Close or abort all tracked streams and stop the muxer
   */
  close (err?: Error | undefined): void {
    if (this.closeController.signal.aborted) return

    this.streams.forEach(s => s.destroy(err))
    this.closeController.abort()
  }

  /**
   * Called whenever an inbound stream is created
   */
  _newReceiverStream (options: { id: number, name: string }) {
    const { id, name } = options
    const registry = this._streams.receivers
    return this._newStream({ id, name, type: 'receiver', registry })
  }

  _newStream (options: { id: number, name: string, type: 'initiator' | 'receiver', registry: Map<number, MplexStream> }) {
    const { id, name, type, registry } = options

    this.log('new %s stream %s %s', type, id)

    if (type === 'initiator' && this._streams.initiators.size === (this._init.maxOutboundStreams ?? MAX_STREAMS_OUTBOUND_STREAMS_PER_CONNECTION)) {
      throw errCode(new Error('Too many outbound streams open'), 'ERR_TOO_MANY_OUTBOUND_STREAMS')
    }

    if (registry.has(id)) {
      throw new Error(`${type} stream ${id} already exists!`)
    }

    const send = (msg: Message) => {
      if (this.log.enabled) {
        this.log.trace('%s stream %s send', type, id, printMessage(msg))
      }

      this.pushToSink(msg)
    }

    const onEnd = () => {
      this.log('%s stream with id %s ended', type, id)
      registry.delete(id)

      if (this._init.onStreamEnd != null) {
        this._init.onStreamEnd(stream)
      }
    }

    const stream = createStream({ id, name, send, type, onEnd, maxMsgSize: this._init.maxMsgSize, loggerFactory: this._init.loggerFactory })
    registry.set(id, stream)
    return stream
  }

  async _handleIncoming (message: Message) {
    const { id, type } = message

    if (this.log.enabled) {
      this.log.trace('incoming message', printMessage(message))
    }

    // Create a new stream?
    if (message.type === MessageTypes.NEW_STREAM) {
      if (this._streams.receivers.size === (this._init.maxInboundStreams ?? MAX_STREAMS_INBOUND_STREAMS_PER_CONNECTION)) {
        this.log('too many inbound streams open')

        // not going to allow this stream, send the reset message manually
        // instead of setting it up just to tear it down
        this.pushToSink({
          id,
          type: MessageTypes.RESET_RECEIVER
        })

        // if we've hit our stream limit, and the remote keeps trying to open
        // more new streams, if they are doing this very quickly maybe they
        // are attacking us and we should close the connection
        try {
          await this.rateLimiter.consume('new-stream', 1)
        } catch {
          this.log('rate limit hit when opening too many new streams over the inbound stream limit - closing remote connection')
          // since there's no backpressure in mplex, the only thing we can really do to protect ourselves is close the connection
          this.destroy(new Error('Too many open streams'))
          return
        }

        return
      }

      const stream = this._newReceiverStream({ id, name: uint8ArrayToString(message.data instanceof Uint8Array ? message.data : message.data.subarray()) })

      if (this._init.onIncomingStream != null) {
        this._init.onIncomingStream(stream)
      }

      return
    }

    const list = (type & 1) === 1 ? this._streams.initiators : this._streams.receivers
    const stream = list.get(id)

    if (stream == null) {
      this.log('missing stream %s for message type %s', id, MessageTypeNames[type])

      return
    }

    const maxBufferSize = this._init.maxStreamBufferSize ?? MAX_STREAM_BUFFER_SIZE

    switch (type) {
      case MessageTypes.MESSAGE_INITIATOR:
      case MessageTypes.MESSAGE_RECEIVER:
        if (stream.sourceReadableLength() > maxBufferSize) {
          // Stream buffer has got too large, reset the stream
          this.pushToSink({
            id: message.id,
            type: type === MessageTypes.MESSAGE_INITIATOR ? MessageTypes.RESET_RECEIVER : MessageTypes.RESET_INITIATOR
          })

          // Inform the stream consumer they are not fast enough
          const error = errCode(new Error('Input buffer full - increase Mplex maxBufferSize to accommodate slow consumers'), 'ERR_STREAM_INPUT_BUFFER_FULL')
          stream.destroy(error)

          return
        }

        // We got data from the remote, push it into our local stream
        stream.sourcePush(message.data)
        break
      case MessageTypes.CLOSE_INITIATOR:
      case MessageTypes.CLOSE_RECEIVER:
        // We should expect no more data from the remote, stop reading
        stream.closeRead()
        break
      case MessageTypes.RESET_INITIATOR:
      case MessageTypes.RESET_RECEIVER:
        // Stop reading and writing to the stream immediately
        stream.reset()
        break
      default:
        this.log('unknown message type %s', type)
    }
  }

  _read (size: number) {}

  _write (chunk: any, encoding: BufferEncoding, callback: (error?: (Error | null)) => void) {
    const messages = this.decoder.write(chunk)
    messages
      .reduce(async (prev, msg) => await prev.then(async () => {
        return await this._handleIncoming(msg)
      }), Promise.resolve())
      .then(() => callback(null))
      .catch((err) => callback(err))
  }

  private pushToSink (msg: Message): void {
    this.encoder.write(msg)
      .forEach((chunk) => {
        this.push(chunk)
      })
  }
}
