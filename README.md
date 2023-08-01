# Node Websocket channel multiplexer 

## WebSocketMultiplex
Bi-directional channel multiplexer that runs on-top of a single
websocket connection. Allows multiple arbitrary data streams
over one connection.

## WebSocketMultiplexSocket
Node.js Duplex stream interface allowing each channel to be used
as any other duplex stream. Compatible interface with net.Socket.