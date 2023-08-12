import * as sinon from 'sinon';
import { assert } from "chai";

import { wsSocketPair, wsmPair } from './test-utils';
import { WebSocketMultiplex } from '../src/ws-multiplex'
import { WebSocketMultiplexError, WebSocketMultiplexErrorCode } from '../src/ws-multiplex-error';
import { WebSocketMultiplexSocket } from '../src/ws-multiplex-socket';
import EventEmitter from 'events';

describe('ws-multiplex', () => {

    let clock: sinon.SinonFakeTimers;
    let socketPair: wsSocketPair;
    let openStub: sinon.SinonStub;

    beforeEach(async () => {
        clock = sinon.useFakeTimers({shouldAdvanceTime: true});
        socketPair = await wsSocketPair.create();
        openStub = sinon.stub(WebSocketMultiplexSocket.prototype, <any>"onOpen");
        sinon.stub(WebSocketMultiplexSocket.prototype, <any>"onClose");
        sinon.stub(WebSocketMultiplexSocket.prototype, <any>"onError");
        sinon.stub(WebSocketMultiplexSocket.prototype, <any>"onData");
        sinon.stub(WebSocketMultiplexSocket.prototype, <any>"onFlowControl");
    });

    afterEach(async () => {
        await socketPair.terminate();
        clock.restore();
        sinon.restore();
    });

    it(`object can be created and destroyed`, async () => {
        const wsm = new WebSocketMultiplex(socketPair.sock1);
        await wsm.destroy();
    });

    it(`object is terminated if the underlying socket is closed`, async () => {
        const wsm = new WebSocketMultiplex(socketPair.sock1);
        wsm.on("error", () => {});
        const terminateSpy = sinon.spy(wsm, <any>"terminate");
        const emitSpy = sinon.spy(wsm, "emit");

        socketPair.sock1.close();
        await new Promise((resolve) => wsm.once("close", resolve));

        assert(terminateSpy.called, "terminate not called");
        assert(emitSpy.firstCall.args[0] == 'error', "error not emitted first");
        assert(emitSpy.firstCall.args[1]?.code == 'ERR_WS_SOCKET_CLOSED_UNEXPECTEDLY',
            "expected error ERR_WS_SOCKET_CLOSED_UNEXPECTEDLY");
        assert(emitSpy.secondCall.args[0] == 'close', "close not emitted");

        await wsm.destroy();
    });

    describe('websocket keep-alive', () => {
        it(`onPong is called`, async () => {
            const spy = sinon.spy(WebSocketMultiplex.prototype, <any>"onPong");
            const [wsm1, wsm2] = wsmPair(socketPair, {
                keepAlive: 2000
            });

            await clock.tickAsync(2100);
            assert(spy.called == true, "onPong not called");

            const lastAlive = wsm1["peerLastAlive"]();
            assert(lastAlive < 2000, "Last alive is greater than keep-alive");

            spy.restore();
            await wsm1.destroy();
            await wsm2.destroy();
        });

        it(`object is destroyed on timeout`, async () => {
            sinon.stub(WebSocketMultiplex.prototype, <any>"onPong");

            const [wsm1, wsm2] = wsmPair(socketPair, {
                keepAlive: 2000
            });

            const emitSpy = sinon.spy(wsm1, "emit");

            wsm2.on("error", () => {});
            wsm1.on("error", () => {});

            const terminateSpy = sinon.spy(wsm1, <any>"terminate");

            await clock.tickAsync(5000);
            const lastAlive = wsm1["peerLastAlive"]();
            assert(lastAlive > 2000, "Last alive updated");

            assert(terminateSpy.called, "terminate not called");

            assert(emitSpy.firstCall.args[0] == 'error', "error not emitted first");
            assert(emitSpy.firstCall.args[1]?.code == 'ERR_WS_PING_TIMEOUT', "expected error ERR_WS_PING_TIMEOUT");
            assert(emitSpy.secondCall.args[0] == 'close', "close not emitted");

            assert(wsm1.closed, "object not in closed state");

            await wsm1.destroy();
            await wsm2.destroy();
        });
    });

    describe('WSM protocol', () => {
        it(`raw buffer can be decoded`, () => {
            const raw = Buffer.from([
                0x00, 0x02, /* Version 2 */
                0x00, 0x01, /* Message type 1 */
                0x00, 0x00, 0x00, 0xff, /* Channel 255 */
                0x00, 0x00, 0x00, 0x01, /* Channel 1 */
                0x00, 0x00, 0x00, 0x04, /* Data length 4 */
                0x41, 0x41, 0x41, 0x41,  /* Data: AAAA */
            ]);

            const [msg, err] = WebSocketMultiplex['decodeMessage'](raw);
            assert(err == undefined);
            assert(msg.header.version == 2);
            assert(msg.header.type == 1);
            assert(msg.header.dstChannel == 255);
            assert(msg.header.srcChannel == 1);
            assert(msg.header.length == 4);
            assert(msg.data.equals(Buffer.from([0x41, 0x41, 0x41, 0x41])));
        });

        it(`too short message returns error`, () => {
            const raw = Buffer.from([
                0x00, 0x02, /* Version 2 */
                0x00, 0x01, /* Message type 1 */
                0x00, 0x00, 0x00, 0xff, /* Channel 255 */
            ]);

            const [msg, err] = WebSocketMultiplex['decodeMessage'](raw);
            assert(msg == undefined);
            assert(err instanceof Error);
        });

        it(`header can be encoded`, () => {
            const data = Buffer.from([0x41, 0x41, 0x41, 0x41]);
            const [header, dataLength] = WebSocketMultiplex['encodeHeader'](1, 255, 1, data);

            const raw = Buffer.from([
                0x00, 0x02, /* Version 2 */
                0x00, 0x01, /* Message type 1 */
                0x00, 0x00, 0x00, 0xff, /* Channel 255 */
                0x00, 0x00, 0x00, 0x01, /* Channel 1 */
                0x00, 0x00, 0x00, 0x04, /* Data length 4 */
            ]);

            assert(header.equals(raw), `got ${header}`);
            assert(dataLength == 4);
        });

        it(`header can be encoded with zero-length data`, () => {
            const [header, dataLength] = WebSocketMultiplex['encodeHeader'](1, 255, 1);

            const raw = Buffer.from([
                0x00, 0x02, /* Version 2 */
                0x00, 0x01, /* Message type 1 */
                0x00, 0x00, 0x00, 0xff, /* Channel 255 */
                0x00, 0x00, 0x00, 0x01, /* Channel 1 */
                0x00, 0x00, 0x00, 0x00, /* Data length 0 */
            ]);

            assert(header.equals(raw));
            assert(dataLength == 0);
        });

        it(`message can be encoded and decoded`, () => {
            const data = Buffer.from([0x41, 0x41, 0x41, 0x41]);
            const [header, _] = WebSocketMultiplex['encodeHeader'](1, 255, 1, data);
            const raw = Buffer.concat([header, data]);

            const [msg, err] = WebSocketMultiplex['decodeMessage'](raw);
            assert(err == undefined);
            assert(msg.header.version == 2);
            assert(msg.header.type == 1);
            assert(msg.header.dstChannel == 255);
            assert(msg.header.srcChannel == 1);
            assert(msg.header.length == 4);
            assert(msg.data.equals(Buffer.from([0x41, 0x41, 0x41, 0x41])));
        });

        it(`encoded messages can be sent`, async () => {

            const getMessage = new Promise((resolve: (buffer: Buffer) => void) => {
                socketPair.sock2.once("message", (data) => {
                    const raw: Buffer = <Buffer>data;
                    resolve(raw);
                });
            })

            const [wsm1, wsm2] = wsmPair(socketPair);

            await new Promise((resolve, reject) => {
                wsm1["sendMessage"](4 /* CLOSE */, 1, 2, Buffer.from([0x41, 0x41]), (err) => {
                    err ? reject(err) : resolve(undefined);
                });
            });

            const raw = await getMessage;
            const [msg, err] = WebSocketMultiplex['decodeMessage'](raw);
            assert(err == undefined);
            assert(msg.header.version == 2);
            assert(msg.header.type == 4);
            assert(msg.header.dstChannel == 1);
            assert(msg.header.srcChannel == 2);
            assert(msg.header.length == 2);
            assert(msg.data.equals(Buffer.from([0x41, 0x41])));

            wsm1.destroy();
            wsm2.destroy();
        });

        it(`encoded messages can be sent with zero-length data`, async () => {

            const getMessage = new Promise((resolve: (buffer: Buffer) => void) => {
                socketPair.sock2.once("message", (data) => {
                    const raw: Buffer = <Buffer>data;
                    resolve(raw);
                });
            })

            const [wsm1, wsm2] = wsmPair(socketPair);

            await new Promise((resolve, reject) => {
                wsm1["sendMessage"](1, 1, 2, undefined, (err) => {
                    err ? reject(err) : resolve(undefined);
                });
            });

            const raw = await getMessage;
            const [msg, err] = WebSocketMultiplex['decodeMessage'](raw);
            assert(err == undefined);
            assert(msg.header.version == 2);
            assert(msg.header.type == 1);
            assert(msg.header.dstChannel == 1);
            assert(msg.header.srcChannel == 2);
            assert(msg.header.length == 0);
            assert(msg.data.equals(Buffer.from([])));

            wsm1.destroy();
            wsm2.destroy();
        });

        it(`unsupported protocol terminates connection`, async () => {
            const [wsm1, wsm2] = wsmPair(socketPair);

            const onError = new Promise((resolve: (err: WebSocketMultiplexError) => void) => {
                wsm2.once("error", (err) => {
                    resolve(err);
                })
            });

            await new Promise((resolve, reject) => {
                const raw = Buffer.from([
                    0x00, 0x00, /* Version 0 */
                    0x00, 0x01, /* Message type 1 */
                    0x00, 0x00, 0x00, 0xff, /* Channel 255 */
                    0x00, 0x00, 0x00, 0x01, /* Channel 1 */
                    0x00, 0x00, 0x00, 0x00, /* Data length 0 */
                ]);
                wsm1["socket"].send(raw, {
                    binary: true,
                    compress: false,
                    fin: true,
                }, resolve);
            });

            const err = await onError;
            assert(err?.code == "ERR_WSM_UNSUPPORTED_PROTOCOL_VERSION");

            wsm1.destroy();
            wsm2.destroy();
        });
    });

    describe('WSM connection', () => {
        let wsm1: WebSocketMultiplex, wsm2: WebSocketMultiplex;

        beforeEach(() => {
            [wsm1, wsm2] = wsmPair(socketPair);
        });

        afterEach(() => {
            wsm1?.destroy();
            wsm2?.destroy();
        });

        describe('channel allocator', () => {
            it(`can allocate channel`, async () => {
                const [channel, err] = wsm1["allocateChannel"]();
                assert(channel == 1);
                assert(err == undefined);
            });

            it(`returns error at max channels`, async () => {
                wsm1["maxChannels"] = 1;
                wsm2["maxChannels"] = 1;

                let [channel, err] = wsm1["allocateChannel"]();
                assert(channel == 1);
                assert(err == undefined);
                wsm1["openChannels"][channel] = <any>{};

                [channel, err] = wsm1["allocateChannel"]();
                assert(channel == undefined);
                assert(err instanceof WebSocketMultiplexError);
                assert(err.code == WebSocketMultiplexErrorCode.ERR_WSM_NO_CHANNELS);
            });
        });

        it(`can listen for new channel connections`, async () => {
            openStub.restore();
            const con = new Promise((resolve) => {
                wsm2.once("connection", (sock) => {
                    resolve(sock);
                });
            });

            const getAck = new Promise((resolve: (buffer: Buffer) => void) => {
                socketPair.sock1.once("message", (data) => {
                    const raw: Buffer = <Buffer>data;
                    resolve(raw);
                });
            })

            wsm1["sendMessage"](2, 0, 2);
            const sock = await con;
            assert(sock instanceof WebSocketMultiplexSocket, `did not get socket, got ${sock}`);
            assert(sock["channel"] == 1, `did not get expected channel, got ${sock["channel"]}`);

            const raw = await getAck;
            const ack = Buffer.from([
                0x00, 0x02, /* Version 2 */
                0x00, 0x03, /* ACK: Message type 3 */
                0x00, 0x00, 0x00, 0x02, /* Dst. Channel 2 */
                0x00, 0x00, 0x00, 0x01, /* Src. Channel 1 */
                0x00, 0x00, 0x00, 0x00, /* Data length 0 */
            ]);
            assert(raw.equals(ack), `did not receive expected ACK, got ${raw.toString('hex')}`);

            assert(wsm2["openChannels"][1] != undefined);
            assert(wsm2["openRemoteChannels"][2] != undefined);

            wsm1.destroy();
            wsm2.destroy();
        });

        it(`connection succeeds with fragmented channel maps`, async () => {
            openStub.restore();
            wsm1["maxChannels"] = 5;
            wsm2["maxChannels"] = 5;

            const connect = async (srcChannel: number) => {
                const con = new Promise((resolve: (sock: WebSocketMultiplexSocket) => void) => {
                    wsm2.once("connection", (sock: WebSocketMultiplexSocket) => {
                        resolve(sock);
                    });
                });

                wsm1["sendMessage"](2, 0, srcChannel);
                return con;
            };

            const sock = await connect(1);
            assert(wsm2["openChannels"][1] != undefined);

            // Populate all channels except one, so that they appear used
            wsm2["openChannels"][2] = wsm2["openChannels"][1];
            wsm2["openChannels"][4] = wsm2["openChannels"][1];
            wsm2["openChannels"][5] = wsm2["openChannels"][1];

            const sock2 = await connect(2);
            assert(sock instanceof WebSocketMultiplexSocket, `did not get socket, got ${sock}`);
            assert(sock2["channel"] == 6);

            assert(wsm2["openChannels"][6] != undefined);
            assert(wsm2["openRemoteChannels"][2] != undefined);

            wsm1.destroy();
            wsm2.destroy();
        });

        it(`connection succeeds with fragmented channel maps with MAX_CHANNEL wrap-around`, async () => {
            openStub.restore();
            wsm1["maxChannels"] = 5;
            wsm2["maxChannels"] = 5;

            const connect = async (srcChannel: number) => {
                const con = new Promise((resolve: (sock: WebSocketMultiplexSocket) => void) => {
                    wsm2.once("connection", (sock: WebSocketMultiplexSocket) => {
                        resolve(sock);
                    });
                });

                wsm1["sendMessage"](2, 0, srcChannel);
                return con;
            };

            const sock = await connect(1);
            assert(wsm2["openChannels"][1] != undefined);

            // Populate all channels except one, so that they appear used
            wsm2["openChannels"][2] = wsm2["openChannels"][1];
            wsm2["openChannels"][4] = wsm2["openChannels"][1];
            wsm2["openChannels"][Math.pow(2, 32)] = wsm2["openChannels"][1];

            wsm1["openRemoteChannels"][2] = wsm1["openRemoteChannels"][1];
            wsm1["openRemoteChannels"][4] = wsm1["openRemoteChannels"][1];
            wsm1["openRemoteChannels"][Math.pow(2, 32)] = wsm1["openRemoteChannels"][1];

            const sock2 = await connect(2);
            assert(sock instanceof WebSocketMultiplexSocket, `did not get socket, got ${sock}`);
            assert(sock2["channel"] == 3);

            assert(wsm2["openChannels"][3] != undefined);
            assert(wsm2["openRemoteChannels"][2] != undefined);

            wsm1.destroy();
            wsm2.destroy();
        });
    });

    describe('WSM API', () => {
        let wsm1: WebSocketMultiplex, wsm2: WebSocketMultiplex;
        let ev: EventEmitter;
        let onError: (err: Error) => void;
        let onData: (data: Buffer) => void;
        let onOpen: (dstChannel: number) => void;
        let onClose: (dstChannel: number) => void;
        let onFlow: (stop: boolean) => void;

        beforeEach(() => {
            [wsm1, wsm2] = wsmPair(socketPair);
            ev = new EventEmitter();
            onError = (err: Error) => {};
            onOpen = (dstChannel: number) => {};
            onClose = (dstChannel: number) => {};
            onData = (data: Buffer) => {};
            onFlow = (stop: boolean) => {};
        });

        afterEach(async () => {
            wsm1?.destroy();
            wsm2?.destroy();
            ev.removeAllListeners();
        });

        const getClose = () => {
            let close: Promise<number>;
            [onClose, close] = generateClose('default');
            return close;
        }

        const getOpen = () => {
            let open: Promise<number>;
            [onOpen, open] = generateOpen('default');
            return open;
        }

        const getError = () => {
            let error: Promise<Error>;
            [onError, error] = generateError('default');
            return error;
        }

        const getData = () => {
            let data: Promise<Buffer>;
            [onData, data] = generateData('default');
            return data;
        }

        const getFlow = () => {
            let stop: Promise<boolean>;
            [onFlow, stop] = generateFlow('default');
            return stop;
        }

        const generateData = (name: string): [(data: Buffer) => void, Promise<Buffer>] => {
            const onEv = (data: Buffer) => {
                ev.emit("data" + name, data);
            };
            const res = new Promise((resolve: (data: Buffer) => void) => {
                ev.once("data" + name, (data: Buffer) => {
                    resolve(data);
                })
            });
            return [onEv, res];
        }

        const generateError = (name: string): [(err: Error) => void, Promise<Error>] => {
            const onEv = (err: Error) => {
                ev.emit("error" + name, err);
            };
            const res = new Promise((resolve: (err: Error) => void) => {
                ev.once("error" + name, (err: Error) => {
                    resolve(err);
                })
            });
            return [onEv, res];
        }

        const generateOpen = (name: string): [(dstChannel: number) => void, Promise<number>] => {
            const onEv = (dstChannel: number) => {
                ev.emit("open" + name, dstChannel);
            };
            const res = new Promise((resolve: (dstChannel: number) => void) => {
                ev.once("open" + name, (dstChannel: number) => {
                    resolve(dstChannel);
                })
            });
            return [onEv, res];
        }

        const generateClose = (name: string): [(dstChannel: number) => void, Promise<number>] => {
            const onEv = (dstChannel: number) => {
                ev.emit("close" + name, dstChannel);
            };
            const res = new Promise((resolve: (dstChannel: number) => void) => {
                ev.once("close" + name, (dstChannel: number) => {
                    resolve(dstChannel);
                })
            });
            return [onEv, res];
        }

        const generateFlow = (name: string): [(stop: boolean) => void, Promise<boolean>] => {
            const onEv = (stop: boolean) => {
                ev.emit("flow" + name, stop);
            };
            const res = new Promise((resolve: (stop: boolean) => void) => {
                ev.once("flow" + name, (stop: boolean) => {
                    resolve(stop);
                })
            });
            return [onEv, res];
        }

        it(`can open a channel`, async () => {
            const open = getOpen();

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, (stop: boolean) => {});
            assert(err == undefined);
            assert(channel == 1);

            const dstChannel = await open;
            assert(dstChannel == 1);
        });

        it(`open on closed websocket returns error`, async () => {
            const error = getError();

            const stub = sinon.stub(wsm1, 'closed').value(true);
            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, (stop: boolean) => {});
            assert(err == undefined);
            assert(channel == 1);

            const openErr = await error;
            assert(openErr instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError error got ${openErr}`);
            assert(openErr.code == 'ERR_WS_SOCKED_CLOSED', `expected ERR_WS_SOCKED_CLOSED, got ${openErr.code}`);
        });

        it(`open with failed OPEN message returns error`, async () => {
            const error = getError();

            const stub = sinon.stub(wsm1, <any>'sendMessage').callsArgWith(4, new Error("send-error"));
            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, (stop: boolean) => {});
            assert(err == undefined);
            assert(channel == 1);

            const openErr = await error;
            assert(openErr instanceof Error, `expected Error got ${openErr}`);
            assert(openErr.message == 'send-error', `expected send-error, got ${openErr.message}`);
        });

        it(`open with no local channels returns error`, async () => {
            wsm1["maxChannels"] = 0;

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, (stop: boolean) => {});
            assert(channel == undefined);
            assert(err instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError got ${err}`);
            assert(err.code == WebSocketMultiplexErrorCode.ERR_WSM_NO_CHANNELS, `expected ERR_WSM_NO_CHANNELS got ${err.code}`);
        });

        it(`open with ACK timeout returns error`, async () => {
            const error = getError();

            // Prevent ACK response to the OPEN message
            const stub = sinon.stub(wsm2, <any>'sendMessage');

            const [channel, err] = wsm1.open({
                timeout: 1000
            }, onOpen, onClose, onError, onData, onFlow);
            assert(err == undefined);
            assert(channel == 1);

            await clock.tickAsync(1001);

            const openErr = await error;
            assert(openErr instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError got ${openErr}`);
            assert(openErr.code == 'ERR_WSM_OPEN_CHANNEL_TIMEOUT', `expected ERR_WSM_OPEN_CHANNEL_TIMEOUT, got ${openErr.code}`);
        });

        it(`open ACK timeout does not trigger on successful connection`, async () => {
            const open = getOpen();

            let openErr: Error | undefined = undefined;
            onError = (err: Error) => {
                openErr = err;
            };

            const [channel, err] = wsm1.open({
                timeout: 1000
            }, onOpen, onClose, onError, onData, onFlow);
            assert(err == undefined);
            assert(channel == 1);

            const dstChannel = await open;
            assert(dstChannel != undefined);

            await clock.tickAsync(1001);
            assert(openErr == undefined, `expected no error, got ${openErr}`);
            assert(wsm1["openChannels"][channel]["ackTimeout"] == undefined, "ackTimeout not cleared");
        });

        it(`open with given dstChannel sends ACK`, async () => {
            const open = getOpen();

            let responseFn = socketPair.getMessageSock2();

            const [channel, err] = wsm1.open({
                dstChannel: 1
            }, onOpen, onClose, onError, onData, (stop: boolean) => {});
            assert(err == undefined);
            assert(channel == 1);

            const dstChannel = await open;
            assert(dstChannel == 1);

            const [msg, msgErr] = await responseFn;
            assert(msg.header.type == 3, `did not get ACK, got ${msg.header.type}`);
        });

        it(`open with given dstChannel and failed ACK message returns error`, async () => {
            const error = getError();

            const stub = sinon.stub(wsm1, <any>'sendMessage').callsArgWith(4, new Error("send-error"));

            const [channel, err] = wsm1.open({
                dstChannel: 1
            }, onOpen, onClose, onError, onData, onFlow);
            assert(err == undefined);
            assert(channel == 1);

            const openErr = await error;
            assert(openErr instanceof Error, `expected Error got ${openErr}`);
            assert(openErr.message == 'send-error', `expected send-error, got ${openErr.message}`);
        });

        it(`open fails when peer responds with CLOSE to OPEN request`, async () => {
            wsm2["maxChannels"] = 0;

            onError = (err: Error) => {
                ev.emit("error", err);
            };
            const error = new Promise((resolve: (err: Error) => void) => {
                ev.once("error", (err: Error) => {
                    resolve(err);
                })
            });

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(err == undefined);
            assert(channel == 1);

            const openErr = await error;
            assert(openErr instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError got ${openErr}`);
            assert(openErr.code == 'ERR_WSM_OPEN_CHANNEL_REJECTED', `expected ERR_WSM_OPEN_CHANNEL_REJECTED, got ${openErr.code}`)
            assert(openErr.remote instanceof WebSocketMultiplexError);
            assert(openErr.remote.code == 'ERR_WSM_NO_CHANNELS');
        });

        it(`open and then close a channel`, async () => {
            const open = getOpen();
            const close = getClose();

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);

            const dstChannel = await open;
            assert(typeof dstChannel == 'number');

            assert(wsm1["openChannels"][channel] != undefined, "Channel context not allocated");
            assert(wsm2["openChannels"][dstChannel] != undefined, "Channel context not allocated");
            assert(wsm1["openRemoteChannels"][dstChannel] == channel, "Incorrect remote channel context");
            assert(wsm2["openRemoteChannels"][channel] == dstChannel, "Incorrect remote channel context");

            const closeSpy = sinon.spy(wsm2, <any>"handleCloseMessage");
            const getMsg = socketPair.getMessageSock2();

            const [closed, closeErr] = wsm1.close(channel);
            assert(closed == true);
            assert(closeErr == undefined);
            assert(wsm1["openChannels"][channel] == undefined, "Channel context still allocated");

            const closedDstChannel = await close;
            assert(closedDstChannel == dstChannel, `closed channel different than open, ${closedDstChannel != dstChannel}`);

            const msg = await getMsg;
            assert(closeSpy.called, "handleCloseMessage not called");
            assert(wsm2["openChannels"][dstChannel] == undefined, "Channel context still allocated");
            assert(wsm2["openRemoteChannels"][channel] == undefined, "Remote channel context still allocated");
        });

        it(`open channel that then is closed by remote`, async () => {
            const open = getOpen();
            const close = getClose();

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);

            const dstChannel = await open;
            assert(typeof dstChannel == 'number');

            const [closed, closeErr] = wsm2.close(dstChannel);
            assert(closed == true, "failed to call close");
            assert(closeErr == undefined);

            const closedDstChannel = await close;
            assert(closedDstChannel == dstChannel, `closed channel different than open, ${closedDstChannel != dstChannel}`);
            assert(wsm1["openChannels"][channel] == undefined, `channel context still present`);
            assert(wsm1["openRemoteChannels"][dstChannel] == undefined, `remote channel context still present`);
        });

        it(`OPEN message on already open channel closes channels`, async () => {
            const open = getOpen();
            const close = getClose();
            const error = getError();

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);
            const dstChannel = await open;

            wsm1["sendMessage"](2 /* OPEN */, 0, channel);

            const closeErr = await error;
            assert(closeErr instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError, got ${closeErr}`);
            assert(closeErr.code == WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_CLOSED_BY_PEER, `expected ERR_WSM_CHANNEL_CLOSED_BY_PEER, got ${closeErr.code}`);
            assert(closeErr.remote instanceof WebSocketMultiplexError, `expected remote WebSocketMultiplexError, got ${closeErr.remote}`);
            assert(closeErr.remote.code == WebSocketMultiplexErrorCode.ERR_WSM_OPEN_CHANNEL_REUSE, `expected ERR_WSM_OPEN_CHANNEL_REUSE, got ${closeErr.remote.code}`);

            const closedDstChannel = await close;
            assert(closedDstChannel == dstChannel);
            assert(wsm1["openChannels"][channel] == undefined, `channel context still present`);
            assert(wsm1["openRemoteChannels"][dstChannel] == undefined, `remote channel context still present`);
            assert(wsm2["openChannels"][dstChannel] == undefined, `channel context still present`);
            assert(wsm2["openRemoteChannels"][channel] == undefined, `remote channel context still present`);
        });

        it(`open with given dstChannel on already open channel returns error`, async () => {
            const open = getOpen();

            let [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);
            const dstChannel = await open;

            [channel, err] = wsm2.open({
                dstChannel
            }, onOpen, onClose, onError, onData, onFlow);

            assert(channel == undefined);
            assert(err instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError, got ${err}`);
            assert(err.code == WebSocketMultiplexErrorCode.ERR_WSM_OPEN_CHANNEL_REUSE, `expected ERR_WSM_CHANNEL_CLOSED_BY_PEER, got ${err.code}`);
        });

        it(`close on non-open channel returns error`, async () => {
            const [closed, closeErr] = wsm2.close(1);
            assert(closed == false, `expected false, got ${closed}`);
            assert(closeErr instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError, got ${closeErr}`);
            assert(closeErr.code == WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_NOT_OPEN, `expected ERR_WSM_CHANNEL_NOT_OPEN, got ${closeErr.code}`);
        });

        it(`CLOSE message on non-open channel is ignored`, async () => {

            const sendSpy = sinon.spy(wsm2, <any>"sendMessage");
            const closeSpy = sinon.spy(wsm2, <any>"handleCloseMessage")
            const closeLocalSpy = sinon.spy(wsm2, <any>"closeLocalChannel");

            const msg = socketPair.getMessageSock2();
            wsm1["sendMessage"](4 /* CLOSE */, 1, 2, Buffer.from("hello"));
            await msg;

            assert(closeSpy.called, "CLOSE handler was not called");
            assert(closeLocalSpy.called, "closeLocalChannel was not called");
            assert(sendSpy.called == false, "sendMessage was called in response to CLOSE");
        });

        it(`channels are closed when object is destroyed`, async () => {
            const open = getOpen();
            const close = getClose();

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);

            const dstChannel = await open;
            assert(typeof dstChannel == 'number');

            await wsm2.destroy();

            const closedDstChannel = await close;
            assert(closedDstChannel == dstChannel, `closed channel different than open, ${closedDstChannel != dstChannel}`);
        });

        it(`send data is received`, async () => {
            const open = getOpen();
            const data = getData();

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);
            const dstChannel = await open;

            assert(wsm1.channelInfo(channel).bytesRead == 0, "bytesRead is not 0");
            assert(wsm2.channelInfo(dstChannel).bytesWritten == 0, "bytesWritten is not 0");

            const res = await new Promise((resolve) => {
                const res = wsm2.send(dstChannel, Buffer.from("hello"), (err) => {
                    resolve(err ? err : res);
                });
            });
            assert(!(res instanceof Error));
            assert(res == true);

            const msg = await data;
            assert(msg.equals(Buffer.from("hello")));

            assert(wsm1.channelInfo(channel).bytesRead == 5);
            assert(wsm2.channelInfo(dstChannel).bytesWritten == 5);
        });

        it(`send on local closed channel returns error`, async () => {
            const res = await new Promise((resolve) => {
                const res = wsm1.send(1, Buffer.from("hello"), (err) => {
                    resolve(err ? err : res);
                });
            });
            assert(res instanceof WebSocketMultiplexError);
            assert(res.code == WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_NOT_OPEN);
        });

        it(`send on remote closed channel results in CLOSE message`, async () => {
            let data: Buffer | undefined = undefined;
            onData = (d: Buffer) => {
                data = d;
            };
            const open = getOpen();

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);
            const dstChannel = await open;

            wsm1["closeLocalChannel"](channel);

            const response = socketPair.getMessageSock2();

            const errorSpy = sinon.spy(wsm2["openChannels"][dstChannel], "onError");
            const closeSpy = sinon.spy(wsm2["openChannels"][dstChannel], "onClose");

            const res = await new Promise((resolve) => {
                const res = wsm2.send(dstChannel, Buffer.from("hello"), (err) => {
                    resolve(err ? err : res);
                });
            });
            assert(!(res instanceof Error));
            assert(res == true);

            // Assert that onError is called
            const msg = await response;
            assert(errorSpy.called);
            const closeError = errorSpy.firstCall.firstArg;
            assert(closeError instanceof WebSocketMultiplexError);
            assert(closeError.code == WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_CLOSED_BY_PEER);
            assert(closeError.remote instanceof WebSocketMultiplexError);
            assert(closeError.remote.code == WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_NOT_OPEN);

            // Assert that onClose is called
            assert(closeSpy.called);
            const closeRes = closeSpy.firstCall.firstArg;
            assert(closeRes == dstChannel);

            // Assert that channel context is removed
            assert(wsm2["openChannels"][dstChannel] == undefined, "channel context still open");
        });

        it(`send after on close remote, but still open local channel results in error`, async () => {
            const open = getOpen();

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);
            const dstChannel = await open;
            assert(wsm1["openChannels"][channel] != undefined, "wsm1 channel context is not set");
            assert(wsm1["openChannels"][channel].dstChannel == dstChannel, `wsm1 expected dstChannel ${dstChannel}, got ${wsm1["openChannels"][channel].dstChannel}`);
            assert(wsm1["openRemoteChannels"][dstChannel] == channel, `wsm1 open remote channel expected ${dstChannel}, got ${wsm1["openRemoteChannels"][dstChannel]}`);

            assert(wsm2["openChannels"][dstChannel] != undefined, "wsm2 channel context is not set");
            assert(wsm2["openChannels"][dstChannel].dstChannel == channel, `wsm2 expected dstChannel ${channel}, got ${wsm2["openChannels"][dstChannel].dstChannel}`);
            assert(wsm2["openRemoteChannels"][channel] == dstChannel, `wsm2 open remote channel expected ${dstChannel}, got ${wsm2["openRemoteChannels"][channel]}`);

            // Close remote without closing local
            const waitMsg = socketPair.getMessageSock2();
            await new Promise((resolve) => { wsm1["closeRemoteChannel"](dstChannel, channel, undefined, resolve) });
            await waitMsg;

            assert(wsm2["openChannels"][dstChannel] == undefined, "wsm2 channel context still set");
            assert(wsm2["openRemoteChannels"][channel] == undefined, `wsm2 open remote channel expected undefined, got ${wsm2["openRemoteChannels"][channel]}`);

            const res = await new Promise((resolve) => { wsm1.send(channel, Buffer.from("hello"), resolve); });
            assert(res instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError got ${res}`);
            assert(res.code == 'ERR_WSM_CHANNEL_NOT_OPEN', `expected ERR_WSM_CHANNEL_NOT_OPEN, got ${res.code}`)
        });

        it(`send with miss-matched channels closes channel`, async () => {
            const [onOpenFirst, openFirst] = generateOpen("first");
            const [onOpenSecond, openSecond] = generateOpen("second");
            const [onCloseFirst, closeFirst] = generateClose("first");
            const [onCloseSecond, closeSecond] = generateClose("second");
            const [onErrorFirst, errorFirst] = generateError("first");
            const [onErrorSecond, errorSecond] = generateError("second");

            const [channelFirst, err1] = wsm1.open({}, onOpenFirst, onCloseFirst, onErrorFirst, onData, onFlow);
            assert(typeof channelFirst == 'number');
            assert(err1 == undefined);
            const dstChannelFirst = await openFirst;

            const [channelSecond, err2] = wsm1.open({}, onOpenSecond, onCloseSecond, onErrorSecond, onData, onFlow);
            assert(typeof channelSecond == 'number');
            assert(err2 == undefined);
            const dstChannelSecond = await openSecond;

            const errorSpyFirst = sinon.spy(wsm2["openChannels"][dstChannelFirst], "onError");
            const errorSpySecond = sinon.spy(wsm2["openChannels"][dstChannelSecond], "onError");
            const closeSpyFirst = sinon.spy(wsm2["openChannels"][dstChannelFirst], "onClose");
            const closeSpySecond = sinon.spy(wsm2["openChannels"][dstChannelSecond], "onClose");

            const stub = sinon.stub(wsm1["openChannels"][channelFirst], "dstChannel").value(dstChannelSecond);
            wsm1.send(channelFirst, Buffer.from("hello"));
            stub.restore();

            let err = await errorFirst;
            assert(err instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError got ${err}`);
            assert(err.code == 'ERR_WSM_CHANNEL_CLOSED_BY_PEER', `expected ERR_WSM_CHANNEL_CLOSED_BY_PEER, got ${err.code}`)
            assert(err.remote instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError got ${err.remote}`);
            assert(err.remote.code == 'ERR_WSM_CHANNEL_MISMATCH', `expected ERR_WSM_CHANNEL_MISMATCH, got ${err.code}`)
            let res = await closeFirst;
            assert(res == 1);

            err = await errorSecond;
            assert(err instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError got ${err}`);
            assert(err.code == 'ERR_WSM_CHANNEL_CLOSED_BY_PEER', `expected ERR_WSM_CHANNEL_CLOSED_BY_PEER, got ${err.code}`)
            assert(err.remote instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError got ${err.remote}`);
            assert(err.remote.code == 'ERR_WSM_CHANNEL_MISMATCH', `expected ERR_WSM_CHANNEL_MISMATCH, got ${err.code}`)
            res = await closeSecond;
            assert(res == 2);

            assert(errorSpyFirst.called);
            let closeError = errorSpyFirst.firstCall.firstArg;
            assert(closeError instanceof WebSocketMultiplexError);
            assert(closeError.code == WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_MISMATCH);

            assert(closeSpyFirst.called);
            let closeRes = closeSpyFirst.firstCall.firstArg;
            assert(closeRes == 1);

            assert(errorSpySecond.called);
            closeError = errorSpySecond.firstCall.firstArg;
            assert(closeError instanceof WebSocketMultiplexError);
            assert(closeError.code == WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_MISMATCH);

            assert(closeSpySecond.called);
            closeRes = closeSpySecond.firstCall.firstArg;
            assert(closeRes == 2);
        });

        it(`send before ACK returns error`, async () => {
            const stub = sinon.stub(wsm1, <any>'sendMessage');

            let [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);
            assert(wsm1["openChannels"][channel].dstChannel == 0, "dstChannel should be zero before ACK");

            err = await new Promise((resolve) => {
                assert(channel != undefined);
                const res = wsm1.send(channel, Buffer.from("hello"), resolve);
                assert(res == false);
            });
            assert(err instanceof WebSocketMultiplexError, `expected WebSocketMultiplexError got ${err}`);
            assert(err.code == 'ERR_WSM_CHANNEL_NOT_OPEN', `expected ERR_WSM_CHANNEL_NOT_OPEN, got ${err.code}`)
        });

        it(`send on multiple channels`, async () => {
            const [onDataFirst, dataFirst] = generateData("first");
            const [onDataSecond, dataSecond] = generateData("second");
            const [onOpenFirst, openFirst] = generateOpen("first");
            const [onOpenSecond, openSecond] = generateOpen("second");

            const [channelFirst, err1] = wsm1.open({}, onOpenFirst, onClose, onError, onDataFirst, onFlow);
            assert(typeof channelFirst == 'number');
            assert(err1 == undefined);
            const dstChannelFirst = await openFirst;

            const [channelSecond, err2] = wsm1.open({}, onOpenSecond, onClose, onError, onDataSecond, onFlow);
            assert(typeof channelSecond == 'number');
            assert(err2 == undefined);
            const dstChannelSecond = await openSecond;

            let res = wsm2.send(dstChannelFirst, Buffer.from("first"));
            assert(res == true);

            res = wsm2.send(dstChannelSecond, Buffer.from("second"));
            assert(res == true);

            let data = await dataFirst;
            assert(data.equals(Buffer.from("first")));

            data = await dataSecond;
            assert(data.equals(Buffer.from("second")));
        });

        it(`send accepts array of two buffers`, async () => {
            const open = getOpen();
            const data = getData();

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);
            const dstChannel = await open;

            const raw = socketPair.getMessageSock1();

            const res = wsm2.send(dstChannel, [Buffer.from("hello"), Buffer.from("world")]);
            assert(res == true);

            const msg = await data;
            assert(msg.equals(Buffer.from("helloworld")));

            const [rawMsg, msgErr] = await raw;
            assert(rawMsg.header.length == 10);
        });

        it(`send accepts array of more buffers`, async () => {
            const open = getOpen();
            const data = getData();

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);
            const dstChannel = await open;

            const res = wsm2.send(dstChannel, [Buffer.from("hello"), Buffer.from(" "), Buffer.from("world")]);
            assert(res == true);

            const msg = await data;
            assert(msg.equals(Buffer.from("hello world")));
        });

        it(`local and remote channel can be different`, async () => {
            const openChannel = async () => {
                const open = getOpen();

                const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
                assert(typeof channel == 'number');
                assert(err == undefined);
                assert(wsm1["openChannels"][channel].dstChannel == 0, "dstChannel should be zero before ACK");

                const dstChannel = await open;
                return [channel, dstChannel];
            };

            const stub = sinon.stub(wsm2, <any>'allocateChannel').returns([10, undefined]);
            let [channel, dstChannel] = await openChannel();
            assert(channel = 1, `expected local channel 1, got ${channel}`);
            assert(dstChannel == 10, `expected remote channel 10, got ${dstChannel}`);
            assert(wsm1["openChannels"][channel].dstChannel == 10, "wsm1 dstChannel not updated after ACK");
            assert(wsm1["openRemoteChannels"][dstChannel] == channel, "wsm1 remote channel not updated after ACK");
            assert(wsm2["openChannels"][dstChannel].dstChannel == 1, "wsm2 dstChannel not updated after OPEN");
            assert(wsm2["openRemoteChannels"][channel] == dstChannel, "wsm2 remote channel not updated after OPEN");

            stub.restore();
            [channel, dstChannel] = await openChannel();
            assert(channel = 2, `expected local channel 2, got ${channel}`);
            assert(dstChannel == 11, `expected remote channel 11, got ${dstChannel}`);
            assert(wsm1["openChannels"][channel].dstChannel == 11, "wsm1 dstChannel not updated after ACK");
            assert(wsm1["openRemoteChannels"][dstChannel] == channel, "wsm1 remote channel not updated after ACK");
            assert(wsm2["openChannels"][dstChannel].dstChannel == 2, "wsm2 dstChannel not updated after OPEN");
            assert(wsm2["openRemoteChannels"][channel] == dstChannel, "wsm2 remote channel not updated after OPEN");
        });

        it(`flow control can trigger pause`, async () => {
            const open = getOpen();
            const flow = getFlow();

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);
            const dstChannel = await open;

            wsm2.flowControl(dstChannel, true);
            const res = await flow;
            assert(res == true, `expected true, got ${res}`);
        });

        it(`flow control can trigger resume`, async () => {
            const open = getOpen();
            const flow = getFlow();

            const [channel, err] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(err == undefined);
            const dstChannel = await open;

            wsm2.flowControl(dstChannel, false);
            const res = await flow;
            assert(res == false, `expected false, got ${res}`);
        });

        it(`flow control on non-open channel returns error`, async () => {
            const err = await new Promise((resolve) => {
                const res = wsm2.flowControl(1, true, resolve);
                assert(res == false)
            });
            assert(err instanceof WebSocketMultiplexError);
            assert(err.code == WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_NOT_OPEN);
        });

        it(`flow control with sendMessage failure return error`, async () => {
            const open = getOpen();
            const error = getError();

            const [channel, openErr] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(openErr == undefined);
            const dstChannel = await open;

            const stub = sinon.stub(wsm1, <any>'sendMessage').callsArgWith(4, new Error("send-error"));
            const err = await new Promise((resolve) => {
                const res = wsm1.flowControl(1, true, (err) => { resolve(err); });
                assert(res == true)
            });
            assert(err instanceof Error, "did not get Error");
            assert(err.message == "send-error");
        });

        it(`flow control on non-open remote channel returns error`, async () => {
            const open = getOpen();
            const close = getClose();
            const error = getError();

            const [channel, openErr] = wsm1.open({}, onOpen, onClose, onError, onData, onFlow);
            assert(typeof channel == 'number');
            assert(openErr == undefined);
            const dstChannel = await open;

            wsm2["closeLocalChannel"](dstChannel);

            await new Promise((resolve) => {
                const res = wsm1.flowControl(1, true, (err) => { resolve(err); });
                assert(res == true)
            });

            const err = await error;
            assert(err instanceof WebSocketMultiplexError);
            assert(err.code == WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_CLOSED_BY_PEER);
            assert(err.remote instanceof WebSocketMultiplexError);
            assert(err.remote.code == WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_NOT_OPEN);

            const closeResult = await close;
            assert(closeResult == dstChannel);
        });
    });

});