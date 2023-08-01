import * as sinon from 'sinon';
import { assert } from "chai";
import { wsSocketPair, wsmPair } from './test-utils';
import { WebSocketMultiplex } from '../src/ws-multiplex';
import { WebSocketMultiplexSocket } from '../src/ws-multiplex-socket';
import { WebSocketMultiplexError, WebSocketMultiplexErrorCode } from '../src/ws-multiplex-error';
import * as http from 'node:http'
import * as net from 'node:net';
import { PassThrough } from 'node:stream';

describe('ws-multiplex-socket', () => {
    let clock: sinon.SinonFakeTimers;
    let socketPair: wsSocketPair;
    let wsm1: WebSocketMultiplex, wsm2: WebSocketMultiplex;

    const connectPair = async () => {
        const listener = new Promise((resolve) => {
            wsm2.once('connection', (sock) => {
                resolve(sock);
            });
        });

        const sock1 = await new Promise((resolve) => {
            const sock = wsm1.createConnection({}, () => {
                resolve(sock);
            });
        });
        const sock2 = await listener;
        assert(sock1 instanceof WebSocketMultiplexSocket, `expected socket, got ${sock1}`);
        assert(sock2 instanceof WebSocketMultiplexSocket, `expected socket, got ${sock2}`);
        return [sock1, sock2];
    };

    beforeEach(async () => {
        clock = sinon.useFakeTimers({shouldAdvanceTime: true});
        socketPair = await wsSocketPair.create();
        [wsm1, wsm2] = wsmPair(socketPair);
    });

    afterEach(async () => {
        await wsm1?.destroy();
        await wsm2?.destroy();
        await socketPair.terminate();
        clock.restore();
        sinon.restore();
    });

    it(`created socket is in initial state `, async () => {
        const sock = new WebSocketMultiplexSocket(wsm1);
        assert(sock.pending == true);
        assert(sock.readyState == "closed");
        assert(sock.destroyed == false);
        assert(sock.connecting == false);
        assert(sock["state"] == "PENDING");
    });

    it(`can connect a socket using createConnection`, async () => {

        const sock = wsm1.createConnection({});
        assert(sock instanceof WebSocketMultiplexSocket, `expected socket, got ${sock}`);
        assert(sock.connecting == true);
        assert(sock.readyState == 'opening');

        const connectEvent = new Promise((resolve) => {
            sock.on('connect', resolve);
        });

        const readyEvent = new Promise((resolve) => {
            sock.on('ready', resolve);
        });

        await connectEvent;
        assert(sock.connecting == <any>false);
        assert(sock.readyState == <any>'open');
        assert(sock.pending == false);
        await readyEvent;

        assert(sock["state"] == "PAUSED", `expected state PAUSED, got ${sock["state"]}`);
        assert(sock["channel"] == 1);
        assert(sock["dstChannel"] == 1);
    });

    it(`connect event callback can be supplied directly to createConnection`, async () => {
        const sock = await new Promise((resolve) => {
            const sock = wsm1.createConnection({}, () => {
                resolve(sock);
            });
        });

        assert(sock instanceof WebSocketMultiplexSocket, `expected socket, got ${sock}`);
    });

    it(`can connect using sock.connect`, async () => {
        const sock = new WebSocketMultiplexSocket(wsm1);
        await new Promise((resolve) => {
            sock.connect({}, () => { resolve(sock); })
        });
        assert(sock["state"] == "PAUSED");
    });

    it(`connection request times out if there is no response`, async () => {
        await wsm2.destroy();
        const sock = wsm1.createConnection({timeout: 1000});
        const emitSpy = sinon.spy(sock, "emit");
        const errorEvent = new Promise((resolve) => {
            sock.on('error', resolve);
        });

        await clock.tickAsync(1001);
        assert(emitSpy.called);
        const err = await errorEvent;
        assert(err instanceof WebSocketMultiplexError);
        assert(err.code == WebSocketMultiplexErrorCode.ERR_WSM_OPEN_CHANNEL_TIMEOUT);
    });

    it(`connected socket can be destroyed by _destroy()`, async () => {
        const sock = await new Promise((resolve) => {
            const sock = wsm1.createConnection({}, () => {
                resolve(sock);
            });
        });

        assert(sock instanceof WebSocketMultiplexSocket, `expected socket, got ${sock}`);
        const closeSpy = sinon.spy(wsm1, "close");

        await new Promise((resolve) => { sock._destroy(null, resolve) });

        assert(closeSpy.called, "close on wsm not called");
        assert(sock.destroyed == true);
        assert(sock.readyState == "closed");
        assert(sock["state"] == "ENDED");
    });

    it(`connected socket can be destroyed by destroy()`, async () => {
        const sock = await new Promise((resolve) => {
            const sock = wsm1.createConnection({}, () => {
                resolve(sock);
            });
        });

        assert(sock instanceof WebSocketMultiplexSocket, `expected socket, got ${sock}`);
        const emitSpy = sinon.spy(sock, "emit");
        const destroySpy = sinon.spy(sock, "_destroy");

        const closeEvent = new Promise((resolve) => {
            sock.on('close', resolve);
        });

        sock.destroy();

        await closeEvent;

        assert(emitSpy.secondCall.args[0] == "close", "close was not emitted at right order");
        assert(destroySpy.called, "_destroy on sock not called");
    });

    it(`connected socket can be destroyed with error by destroy()`, async () => {
        const sock = await new Promise((resolve) => {
            const sock = wsm1.createConnection({}, () => {
                sock.on('data', () => {});
                resolve(sock);
            });
        });

        assert(sock instanceof WebSocketMultiplexSocket, `expected socket, got ${sock}`);
        const emitSpy = sinon.spy(sock, "emit");
        const destroySpy = sinon.spy(sock, "_destroy");

        const closeEvent = new Promise((resolve) => {
            sock.on('close', resolve);
        });
        const errorEvent = new Promise((resolve) => {
            sock.on('error', resolve);
        });

        sock.destroy(new Error("destroy-error"));

        await errorEvent;
        await closeEvent;

        assert(emitSpy.firstCall.args[0] == "error", "error was not emitted at right order");
        assert(emitSpy.firstCall.args[1] instanceof Error, "error not emitted");
        assert(emitSpy.firstCall.args[1].message == "destroy-error", "error not emitted");
        assert(emitSpy.secondCall.args[0] == "close", "close was not emitted at right order");
        assert(destroySpy.called, "_destroy on sock not called");
    });

    it(`connected sock can be closed by remote peer`, async () => {
        const sock = await new Promise((resolve) => {
            const sock = wsm1.createConnection({}, () => {
                sock.on('data', () => {});
                resolve(sock);
            });
        });
        assert(sock instanceof WebSocketMultiplexSocket, `expected socket, got ${sock}`);

        const emitSpy = sinon.spy(sock, "emit");
        const closeEvent = new Promise((resolve) => {
            sock.on('close', resolve);
        });
        let error: Error | undefined = undefined;
        sock.on('error', (err: Error) => {
            error = err;
        });

        wsm2.close(<number>sock["dstChannel"]);

        await closeEvent;
        assert(error == undefined, "error was emitted, non expected")
        assert(emitSpy.callCount == 3, `expected 3 emit, got ${emitSpy.callCount}`);
        assert(emitSpy.getCall(0).args[0] == "prefinish", "first event is not prefinish");
        assert(emitSpy.getCall(1).args[0] == "finish", "second event is not finish");
        assert(emitSpy.getCall(2).args[0] == "close", "third event is not close");
    });

    it(`write on non-socket fails`, async () => {
        const sock = new WebSocketMultiplexSocket(wsm1);
        const errEvent = new Promise((resolve) => { sock.once("error", resolve) });
        sock.write(Buffer.from("hello"));
        const err = await errEvent;
        assert(err instanceof Error);
    });

    it(`write after destroy fails`, async () => {
        const sock = await new Promise((resolve) => {
            const sock = wsm1.createConnection({}, () => {
                resolve(sock);
            });
        });

        assert(sock instanceof WebSocketMultiplexSocket, `expected socket, got ${sock}`);

        const closeEvent = new Promise((resolve) => {
            sock.on('close', resolve);
        });

        sock.destroy();
        await closeEvent;

        const err = await new Promise((resolve) => {
            sock.write(Buffer.from("hello"), resolve);
        });
        assert(err instanceof Error);
    });

    it(`write after remote close fails`, async () => {
        const sock = await new Promise((resolve) => {
            const sock = wsm1.createConnection({}, () => {
                resolve(sock);
            });
        });

        assert(sock instanceof WebSocketMultiplexSocket, `expected socket, got ${sock}`);

        const closeEvent = new Promise((resolve) => {
            sock.on('close', resolve);
        });

        wsm2.close(<number>sock["dstChannel"]);
        await closeEvent;

        const err = await new Promise((resolve) => {
            sock.write(Buffer.from("hello"), resolve);
        });
        assert(err instanceof Error);
    });

    it(`can send and receive data on connected socket`, async () => {
        const listener = new Promise((resolve) => {
            wsm2.once('connection', (sock) => {
                resolve(sock);
            });
        });

        const sock1 = await new Promise((resolve) => {
            const sock = wsm1.createConnection({}, () => {
                resolve(sock);
            });
        });
        assert(sock1 instanceof WebSocketMultiplexSocket, `expected socket, got ${sock1}`);

        const sock2 = await listener;
        assert(sock2 instanceof WebSocketMultiplexSocket, `expected socket, got ${sock2}`);

        // Send data sock1 -> sock2
        let dataEvent: Promise<Buffer> = new Promise((resolve) => {
            sock2.once('data', resolve);
        });

        let res = sock1.write(Buffer.from("hello"));
        assert(res == true);

        let data = await dataEvent;
        assert(data.equals(Buffer.from("hello")));

        // Send data sock2 -> sock1
        dataEvent = new Promise((resolve) => {
            sock1.once('data', resolve);
        });

        res = sock2.write(Buffer.from("hello2"));
        assert(res == true);

        data = await dataEvent;
        assert(data.equals(Buffer.from("hello2")));
    });

    it(`socket is opened in paused state without data listener`, async () => {
        const sock = new WebSocketMultiplexSocket(wsm1);
        await new Promise((resolve) => { sock.connect({}, () => { resolve(undefined)}); })
        assert(sock.isPaused());
    });

    it(`socket is opened in open state with a data listener`, async () => {
        const sock = new WebSocketMultiplexSocket(wsm1);
        sock.on('data', () => {});
        await new Promise((resolve) => { sock.connect({}, () => { resolve(undefined)}); })
        assert(!sock.isPaused());
    });

    it(`socket is resumed when pipe is added`, async () => {
        const sock = new WebSocketMultiplexSocket(wsm1);
        await new Promise((resolve) => { sock.connect({}, () => { resolve(undefined)}); })
        assert(sock.isPaused());

        const stream = new PassThrough();
        stream.pipe(sock);
        assert(!sock.isPaused());
    });

    it(`can open multiple sockets`, async () => {
        const [sock1, sock2] = await connectPair();
        const [sock3, sock4] = await connectPair();

        const dataEvent2: Promise<Buffer> = new Promise((resolve) => {
            sock2.once('data', resolve);
        });

        const dataEvent3: Promise<Buffer> = new Promise((resolve) => {
            sock3.once('data', resolve);
        });

        sock1.write(Buffer.from("hello1"));
        sock4.write(Buffer.from("hello4"));

        const data2 = await dataEvent2;
        const data3 = await dataEvent3;
        assert(data2.equals(Buffer.from("hello1")));
        assert(data3.equals(Buffer.from("hello4")));
    });

    it(`pausing/resuming socket corks/uncorks remote socket`, async () => {
        const [sock1, sock2] = await connectPair();

        const corkSpy = sinon.spy(sock2, "cork");
        const uncorkSpy = sinon.spy(sock2, "uncork");

        sock1.pause();
        assert(sock1["state"] == "PAUSED");

        for (let i = 0; corkSpy.callCount == 0 && i < 10; i++) {
            await clock.tickAsync(1000);
        }
        assert(corkSpy.called, "cork not called on sock2");

        sock1.resume();
        assert(sock1["state"] == <any>"OPEN");
        for (let i = 0; uncorkSpy.callCount == 0 && i < 10; i++) {
            await clock.tickAsync(1000);
        }
        assert(uncorkSpy.called, "uncork not called on sock2");
    });

    it(`pausing open socket, pauses data stream`, async () => {
        const [sock1, sock2] = await connectPair();
        const uncorkSpy = sinon.spy(sock2, "uncork");
        const corkSpy = sinon.spy(sock2, "cork");

        sock1.resume();
        assert(sock1["state"] == <any>"OPEN");
        for (let i = 0; uncorkSpy.callCount == 0 && i < 10; i++) {
            await clock.tickAsync(1000);
        }
        assert(uncorkSpy.called, "uncork not called on sock2");

        const dataEvent: Promise<Buffer> = new Promise((resolve) => {
            sock1.on('data', resolve);
        });

        sock1.pause();
        assert(sock1["state"] == "PAUSED");
        for (let i = 0; corkSpy.callCount == 0 && i < 10; i++) {
            await clock.tickAsync(1000);
        }
        assert(corkSpy.called, "cork not called on sock2");

        sock2.write(Buffer.from("hello"));

        let res = await Promise.race([
            dataEvent,
            new Promise(async (resolve) => {
                await clock.tickAsync(1000);
                resolve("timeout");
            })
        ]);
        assert(uncorkSpy.callCount == 1, "uncork called");
        assert(res == "timeout", `expected timeout, got ${res}`);

        sock1.resume();
        res = await dataEvent;
        assert(res == 'hello', "data not received after resume");
    });

    describe(`complex use cases`, () => {
        const createEchoHttpServer = async (port = 20000) => {
            const requestHandler = (request: http.IncomingMessage, response: http.ServerResponse) => {
                let body: Array<Buffer> = [];
                request.on('data', (chunk: Buffer) => {
                    body.push(chunk);
                }).on('end', () => {
                    const buf = Buffer.concat(body).toString();
                    response.statusCode = 200;
                    response.end(buf);
                });
            }
            const server = http.createServer(requestHandler);
            server.listen(port);
            return {
                destroy: () => {
                    server.removeAllListeners('request');
                    server.close();
                }
            };
        };

        it(`http server/client`, async () => {
            const targetServer = await createEchoHttpServer();

            wsm2.on('connection', (sock) => {
                const targetSock = new net.Socket();
                targetSock.connect({
                    host: 'localhost',
                    port: 20000
                }, () => {
                    targetSock.pipe(sock);
                    sock.pipe(targetSock);
                });

                const close = () => {
                    targetSock.unpipe(sock);
                    sock.unpipe(targetSock);
                    targetSock.destroy();
                    sock.destroy();
                };
                targetSock.on('close', close);
                sock.on('close', close);
            });

            const server = new net.Server()
                .on('connection', (client) => {
                    const wsmSock = wsm1.createConnection({}, () => {
                        wsmSock.pipe(client);
                        client.pipe(wsmSock);
                    });
                    const close = () => {
                        wsmSock.unpipe(client);
                        client.unpipe(wsmSock);
                        wsmSock.destroy();
                        client.destroy();
                    };
                    wsmSock.on('close', close);
                    client.on('close', close);
                })
                .listen(30000);

            // GET request
            let res = await fetch("http://localhost:30000")
            assert(res.status == 200, `Did not get status 200, got ${res.status}`);

            // POST request
            res = await fetch("http://localhost:30000", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    'foo': 'bar'
                })
            });
            assert(res.status == 200, `Did not get status 200, got ${res.status}`);
            let data = await res.text();
            assert(data == '{"foo":"bar"}', `Did not get expected response, got ${data}`);

            // POST with binary
            res = await fetch("http://localhost:30000", {
                method: "POST",
                headers: {
                    "Content-Type": "binary/octet-stream",
                },
                body: Buffer.from([0x1, 0x2, 0x3, 0x4])
            });

            assert(res.status == 200, `Did not get status 200, got ${res.status}`);
            let buffer = await (await res.blob()).arrayBuffer();
            assert(Buffer.from(buffer).equals(Buffer.from([0x1, 0x2, 0x3, 0x4])),
                `Did not get expected response, got ${buffer}`);

            server.close();
            targetServer.destroy();
        });
    });

});