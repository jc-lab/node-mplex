import * as streams from 'stream'
import errCode from 'err-code'
import { MAX_MSG_SIZE } from './restrict-size'
import { InitiatorMessageTypes, ReceiverMessageTypes } from './message-types'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { Uint8ArrayList } from './thirdparty/uint8arraylist'
import type { Message } from './message-types'
import type { Stream } from './types'
import { dummyLogger, LoggerFactory } from './logger'

const ERR_STREAM_RESET = 'ERR_STREAM_RESET'
const ERR_STREAM_ABORT = 'ERR_STREAM_ABORT'
const ERR_SINK_ENDED = 'ERR_SINK_ENDED'
const ERR_DOUBLE_SINK = 'ERR_DOUBLE_SINK'

export interface Options {
  id: number
  send: (msg: Message) => void
  name?: string
  onEnd?: (err?: Error) => void
  type?: 'initiator' | 'receiver'
  maxMsgSize?: number
  loggerFactory?: LoggerFactory
}

export interface MplexStream extends Stream {
  sourceReadableLength: () => number
  sourcePush: (data: Uint8ArrayList) => void
}

export function createStream (options: Options): MplexStream {
  const { id, name, send, onEnd, type = 'initiator', maxMsgSize = MAX_MSG_SIZE, loggerFactory } = options

  const log = loggerFactory ? loggerFactory('mplex:stream') : dummyLogger()

  const abortController = new AbortController()
  const resetController = new AbortController()
  const closeController = new AbortController()
  const Types = type === 'initiator' ? InitiatorMessageTypes : ReceiverMessageTypes
  const externalId = type === 'initiator' ? (`i${id}`) : `r${id}`
  const streamName = `${name == null ? id : name}`

  let readableLength = 0

  let sourceEnded = false
  let sinkEnded = false
  let sinkSunk = false
  let endErr: Error | undefined

  const uint8ArrayList = new Uint8ArrayList()

  const onSourceEnd = (err?: Error) => {
    if (sourceEnded) {
      return
    }

    sourceEnded = true
    log.trace('%s stream %s source end - err: %o', type, streamName, err)

    if (err != null && endErr == null) {
      endErr = err
    }

    if (sinkEnded) {
      if (onEnd != null) {
        stream.destroy(err)
        onEnd(endErr)
      }
    }
  }

  const onSinkEnd = (err?: Error) => {
    if (sinkEnded) {
      return
    }
    sinkEnded = true
    log.trace('%s stream %s sink end - err: %o', type, streamName, err)

    if (err != null && endErr == null) {
      endErr = err
    }

    if (sourceEnded) {
      if (onEnd != null) {
        stream.destroy(err)
        onEnd(endErr)
      }
    }
  }

  const onFinal = () => {
    try {
      send({ id, type: Types.CLOSE })
    } catch (err) {
      log.trace('%s stream %s error sending close', type, name, err)
    }

    onSinkEnd()
  }

  const stream: MplexStream = new streams.Duplex({
    autoDestroy: true,
    final (callback: (error?: (Error | null)) => void): void {
      onFinal()
      callback()
    },
    read (size: number): void {
      readableLength = size
    },
    write (data: any, encoding: BufferEncoding, callback: (error?: (Error | null)) => void): void {
      uint8ArrayList.append(data)

      while (uint8ArrayList.length !== 0) {
        if (uint8ArrayList.length <= maxMsgSize) {
          send({ id, type: Types.MESSAGE, data: uint8ArrayList.sublist() })
          uint8ArrayList.consume(uint8ArrayList.length)
          break
        }

        send({ id, type: Types.MESSAGE, data: uint8ArrayList.sublist(0, maxMsgSize) })
        uint8ArrayList.consume(maxMsgSize)
      }

      callback()
    }
  }) as MplexStream

  Object.assign(stream, {
    // Close for both Reading and Writing
    close: () => {
      log.trace('%s stream %s close', type, streamName)

      stream.closeRead()
      stream.closeWrite()
    },

    // Close for reading
    closeRead: () => {
      log.trace('%s stream %s closeRead', type, streamName)

      if (sourceEnded) {
        return
      }

      stream.push(null)

      onSourceEnd()
    },

    // Close for writing
    closeWrite: () => {
      log.trace('%s stream %s closeWrite', type, streamName)

      if (sinkEnded) {
        return
      }

      closeController.abort()

      try {
        send({ id, type: Types.CLOSE })
      } catch (err) {
        log.trace('%s stream %s error sending close', type, name, err)
      }

      onSinkEnd()
    },

    // Close for reading and writing (local error)
    abort: (err: Error) => {
      log.trace('%s stream %s abort', type, streamName, err)
      // End the source with the passed error
      onSourceEnd()
      abortController.abort()
      onSinkEnd(err)
    },

    // Close immediately for reading and writing (remote error)
    reset: () => {
      const err = errCode(new Error('stream reset'), ERR_STREAM_RESET)
      resetController.abort()
      onSourceEnd(err)
      onSinkEnd(err)
    },

    sourcePush: (data: Uint8ArrayList) => {
      [...data].forEach((chunk) => {
        stream.push(chunk)
      })
    },

    sourceReadableLength () {
      return readableLength
    },

    metadata: {},

    id: externalId
  } as Partial<MplexStream>)

  const start = () => {
    if (sinkSunk) {
      throw errCode(new Error('sink already called on stream'), ERR_DOUBLE_SINK)
    }

    sinkSunk = true

    if (sinkEnded) {
      throw errCode(new Error('stream closed for writing'), ERR_SINK_ENDED)
    }

    try {
      if (type === 'initiator') { // If initiator, open a new stream
        send({ id, type: InitiatorMessageTypes.NEW_STREAM, data: new Uint8ArrayList(uint8ArrayFromString(streamName)) })
      }
    } catch (err: any) {
      if (err.type === 'aborted' && err.message === 'The operation was aborted') {
        if (closeController.signal.aborted) {
          return
        }

        if (resetController.signal.aborted) {
          err.message = 'stream reset'
          err.code = ERR_STREAM_RESET
        }

        if (abortController.signal.aborted) {
          err.message = 'stream aborted'
          err.code = ERR_STREAM_ABORT
        }
      }

      // Send no more data if this stream was remotely reset
      if (err.code === ERR_STREAM_RESET) {
        log.trace('%s stream %s reset', type, name)
      } else {
        log.trace('%s stream %s error', type, name, err)
        try {
          send({ id, type: Types.RESET })
        } catch (err) {
          log.trace('%s stream %s error sending reset', type, name, err)
        }
      }

      onSourceEnd(err)
      onSinkEnd(err)
    }
  }
  start()

  return stream
}
