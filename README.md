# node-mplex <!-- omit in toc -->

> stream implementation of <https://github.com/libp2p/js-libp2p-mplex>

## Install

```console
$ yarn add node-mplex
```

## Usage

```typescript
import { Mplex } from 'node-mplex'

const factory = new Mplex()

const server = factory.createStreamMuxer({
  onStream: stream => { // Receive a duplex stream from the remote
    // ...receive data from the remote and optionally send data back
  },
  onStreamEnd: stream => {
    // ...handle any tracking you may need of stream closures
  }
})

const client = new MplexStreamMuxer({})

server.pipe(client).pipe(server) // conn is duplex connection to another peer

const stream = client.newStream() // Create a new duplex stream to the remote

stream.write('aaaa')
stream.end()
```

## API

### `const factory = new Mplex([options])`

Creates a factory that can be used to create new muxers.

`options` is an optional `Object` that may have the following properties:

- `maxMsgSize` - a number that defines how large mplex data messages can be in bytes, if messages are larger than this they will be sent as multiple messages (default: 1048576 - e.g. 1MB)
- `maxInboundStreams` - a number that defines how many incoming streams are allowed per connection (default: 1024)
- `maxOutboundStreams` - a number that defines how many outgoing streams are allowed per connection (default: 1024)
- `maxStreamBufferSize` - a number that defines how large the message buffer is allowed to grow (default: 1024 \* 1024 \* 4 - e.g. 4MB)
- `disconnectThreshold` - if `maxInboundStreams` is reached, close the connection if the remote continues trying to open more than this many streams per second (default: 5)

### `const muxer = factory.createStreamMuxer(components, [options])`

Create a new *duplex* stream that can be piped together with a connection in order to allow multiplexed communications.

e.g.

```js
import { Mplex } from 'node-mplex'

const factory = new Mplex()

// Create a duplex muxer
const muxer = factory.createStreamMuxer()

// Use the muxer in a pipeline
conn.pipe(muxer).pipe(conn) // conn is duplex connection to another peer
```

`options` is an optional `Object` that may have the following properties:

- `onStream` - A function called when receiving a new stream from the remote. e.g.
  ```js
  // Receive a new stream on the muxed connection
  const onStream = stream => {
    // Read from this stream and write back to it (echo server)
    pipe(
      stream,
      source => (async function * () {
        for await (const data of source) yield data
      })(),
      stream
    )
  }
  const muxer = new Mplex({ onStream })
  // ...
  ```
  **Note:** The `onStream` function can be passed in place of the `options` object. i.e.
  ```js
  new Mplex(stream => { /* ... */ })
  ```
- `onStreamEnd` - A function called when a stream ends
  ```js
  // Receive a notification when a stream ends
  const onStreamEnd = stream => {
    // Manage any tracking changes, etc
  }
  const muxer = new Mplex({ onStreamEnd })
  // ...
  ```
- `signal` - An [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) which can be used to abort the muxer, *including* all of it's multiplexed connections. e.g.
  ```js
  const controller = new AbortController()
  const muxer = new Mplex({ signal: controller.signal })

  pipe(conn, muxer, conn)

  controller.abort()
  ```
- `maxMsgSize` - The maximum size in bytes the data field of multiplexed messages may contain (default 1MB)

### `muxer.onStream`

Use this property as an alternative to passing `onStream` as an option to the `Mplex` constructor.

### `muxer.onStreamEnd`

Use this property as an alternative to passing `onStreamEnd` as an option to the `Mplex` constructor.

### `muxer.streams`

Returns an `Array` of streams that are currently open. Closed streams will not be returned.

### `const stream = muxer.newStream([options])`

Initiate a new stream with the remote. Returns a [duplex stream](https://gist.github.com/alanshaw/591dc7dd54e4f99338a347ef568d6ee9#duplex-it).

e.g.

```js
// Create a new stream on the muxed connection
const stream = muxer.newStream()

// Use this new stream like any other duplex stream:
stream.on('data', (data) => {
  console.log(data)
})
stream.write(Buffer.from('hello'))
```

In addition to `sink` and `source` properties, this stream also has the following API, that will **normally *not* be used by stream consumers**.

#### `stream.close()`

Closes the stream for **reading**. If iterating over the source of this stream in a `for await of` loop, it will return (exit the loop) after any buffered data has been consumed.

This function is called automatically by the muxer when it receives a `CLOSE` message from the remote.

The source will return normally, the sink will continue to consume.

#### `stream.abort([err])`

Closes the stream for **reading** *and* **writing**. This should be called when a *local error* has occurred.

Note, if called without an error any buffered data in the source can still be consumed and the stream will end normally.

This will cause a `RESET` message to be sent to the remote, *unless* the sink has already ended.

The sink will return and the source will throw if an error is passed or return normally if not.

#### `stream.reset()`

Closes the stream *immediately* for **reading** *and* **writing**. This should be called when a *remote error* has occurred.

This function is called automatically by the muxer when it receives a `RESET` message from the remote.

The sink will return and the source will throw.

#### `stream.timeline`

Returns an `object` with `close` and `open` times of the stream.

#### `stream.id`

Returns a `string` with an identifier unique to **this** muxer. Identifiers are not unique across muxers.

## License

Licensed under either of

- Apache 2.0, ([LICENSE-APACHE](LICENSE-APACHE) / <http://www.apache.org/licenses/LICENSE-2.0>)
- MIT ([LICENSE-MIT](LICENSE-MIT) / <http://opensource.org/licenses/MIT>)

## Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
