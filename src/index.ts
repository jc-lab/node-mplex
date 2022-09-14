import {
  StreamMuxerInit
} from './types'
import {
  MplexInit,
  MplexStreamMuxer
} from './mplex'

export * from './types'
export * from './logger'
export * from './mplex'

export class Mplex {
  private readonly _init: MplexInit

  constructor (init: MplexInit = {}) {
    this._init = init
  }

  createStreamMuxer (init: StreamMuxerInit = {}): MplexStreamMuxer {
    return new MplexStreamMuxer({
      ...init,
      ...this._init
    })
  }
}
