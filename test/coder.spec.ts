/* eslint-env mocha */
/* eslint max-nested-callbacks: ["error", 5] */

const { expect, assert } = require('chai')
  .use(require('chai-bytes'));
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { concat as uint8ArrayConcat } from 'uint8arrays/concat'
import { messageWithBytes, encode, decode } from './fixtures/utils'
import type { Message, NewStreamMessage } from '../src/message-types'
import { Uint8ArrayList } from '../src/thirdparty/uint8arraylist'

async function all(source: Uint8Array[]): Promise<Uint8Array[]> {
  return source;
}

describe('coder', () => {

  it('should encode header', async () => {
    const source: Message[] = [{ id: 17, type: 0, data: new Uint8ArrayList(uint8ArrayFromString('17')) }]

    const data = uint8ArrayConcat(encode(source))

    const expectedHeader = uint8ArrayFromString('880102', 'base16')
    expect(data.slice(0, expectedHeader.length)).to.equalBytes(expectedHeader)
  })

  it('should decode header', async () => {
    const source = [uint8ArrayFromString('8801023137', 'base16')]
    for (const msgs of decode(source)) {
      expect(msgs.length).to.equal(1)

      expect(messageWithBytes(msgs[0])).to.be.deep.equal({ id: 17, type: 0, data: uint8ArrayFromString('17') })
    }
  })

  it('should encode several msgs into buffer', async () => {
    const source: Message[] = [
      { id: 17, type: 0, data: new Uint8ArrayList(uint8ArrayFromString('17')) },
      { id: 19, type: 0, data: new Uint8ArrayList(uint8ArrayFromString('19')) },
      { id: 21, type: 0, data: new Uint8ArrayList(uint8ArrayFromString('21')) }
    ]

    const data = uint8ArrayConcat(encode(source))

    expect(data).to.equalBytes(uint8ArrayFromString('88010231379801023139a801023231', 'base16'))
  })

  it('should encode from Uint8ArrayList', async () => {
    const source: NewStreamMessage[] = [{
      id: 17,
      type: 0,
      data: new Uint8ArrayList(
        uint8ArrayFromString(Math.random().toString()),
        uint8ArrayFromString(Math.random().toString())
      )
    }]

    const data = uint8ArrayConcat(await all(encode(source)))

    expect(data).to.equalBytes(
      uint8ArrayConcat([
        uint8ArrayFromString('8801', 'base16'),
        Uint8Array.from([source[0].data.length]),
        source[0].data instanceof Uint8Array ? source[0].data : source[0].data.slice()
      ])
    )
  })

  it('should decode msgs from buffer', async () => {
    const source = [uint8ArrayFromString('88010231379801023139a801023231', 'base16')]

    const res: Message[] = []
    for await (const msgs of decode(source)) {
      res.push(...msgs)
    }

    expect(res.map(messageWithBytes)).to.deep.equal([
      { id: 17, type: 0, data: uint8ArrayFromString('17') },
      { id: 19, type: 0, data: uint8ArrayFromString('19') },
      { id: 21, type: 0, data: uint8ArrayFromString('21') }
    ])
  })

  it('should encode zero length body msg', async () => {
    const source: Message[] = [{ id: 17, type: 0 }]

    const data = uint8ArrayConcat(await all(encode(source)))

    expect(data).to.equalBytes(uint8ArrayFromString('880100', 'base16'))
  })

  it('should decode zero length body msg', async () => {
    const source = [uint8ArrayFromString('880100', 'base16')]

    for await (const msgs of decode(source)) {
      expect(msgs.length).to.equal(1)
      expect(messageWithBytes(msgs[0])).to.be.eql({ id: 17, type: 0, data: new Uint8Array(0) })
    }
  })
})
