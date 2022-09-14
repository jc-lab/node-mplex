import { Stream, MplexStreamMuxer } from '../src'

function createPair (onStream: (stream: Stream) => void): [MplexStreamMuxer, MplexStreamMuxer] {
  const server = new MplexStreamMuxer({
    onIncomingStream: onStream
  })

  const client = new MplexStreamMuxer({})

  server.pipe(client).pipe(server)

  return [server, client]
}

const [server, client] = createPair((stream) => {
  let received = ''
  stream.on('data', (data) => {
    received += Buffer.from(data).toString('utf8')
  })
  stream.on('end', () => {
    console.log('SERVER: received: ' + received)
    stream.close()
  })
  stream.on('close', () => {
    console.log('SERVER: CLOSED')
  })
})

const s1 = client.newStream('hello')
setTimeout(() => {
  s1.on('close', () => {
    console.log('CLOSED: CLOSED')
  })
  s1.write('aaaaaaaaaa', (err) => {
    s1.end(() => {
      s1.close()
    })
  })
}, 500)
