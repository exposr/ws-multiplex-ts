/**
 * Multiplexes multiple streams over one websocket connection
 * Bi-directional channel creation.
 */

import { strict as assert } from 'assert';
import { EventEmitter } from 'node:stream';
import { WebSocket } from 'ws';
import { WebSocketMultiplexError, WebSocketMultiplexErrorCode } from './ws-multiplex-error';
import { WebSocketMultiplexSocket, WebSocketMultiplexSocketOptions } from './ws-multiplex-socket';

const DEFAULT_KEEP_ALIVE: number = 10000;
const CHANNEL_MIN: number = 1;
const CHANNEL_MAX: number = Math.pow(2, 32);
const DEFAULT_MAX_OPEN_CHANNELS: number = 65535;
const DEFAULT_OPEN_TIMEOUT: number = 5000;

enum WSMVersion {
    VERSION_1 = 1,
    /**
     * Version 2 Frame format
     * 0        2     4             8            12      16
     * [VERSION][TYPE][DEST_CHANNEL][SRC_CHANNEL][LENGTH][DATA...]
     */
    VERSION_2 = 2,
}

enum WSMMessageType {
    /**
     * Data frame
     *
     * The data following the header is destined for the destination channel.
     *
     * The channel must have been previously opened with an OPEN request and
     * acknowledged by the peer with an ACK message.
     */
    MESSAGE_DATA = 1,
    /**
     * Channel Open request frame
     *
     * Request from peer to open a new channel.
     * The destination channel is 0, and the source channel is set
     * to the peer channel.
     *
     * To accept the open request
     *  Respond with a MESSAGE_ACK with the dest channel set to the peers source channel.
     *  The source channel of the ACK message must be set to the local source channel.
     *
     * To reject the open request
     *  Respond with a MESSAGE_CLOSE  with the dest channel set to the peers source channel.
     *  The source channel of the CLOSE message must be set to 0.
     */
    MESSAGE_OPEN = 2,
    /**
     * Channel Open acknowledge frame
     *
     * Accept an OPEN request.
     * Set destination channel to the peers source channel number.
     * Set source channel to the selected local channel number.
     */
    MESSAGE_ACK = 3,
    /**
     * Channel Close frame
     *
     * Close an open channel.
     * The destination channel must be set to the channel to close.
     */
    MESSAGE_CLOSE = 4,
    /**
     * Channel pause frame
     *
     * Instruct the peer to stop sending data on the channel specified by
     * the channel in the destination channel field. This will pause the delivery
     * of DATA frames.
     *
     * When a pause message is received, the peer should stop sending data and buffer
     * any data until a resume frame is received.
     */
    MESSAGE_PAUSE = 5,
    /**
     * Channel resume frame
     *
     * Resume a previously paused channel.
     * The destination channel must be set to the channel to resume.
     */
    MESSAGE_RESUME = 6,
}

/**
 * On-wire message
 */
type WSMMessage = {
    header: WSMHeader,
    data: Buffer,
}

type WSMHeader = {
    version: WSMVersion,
    type: WSMMessageType,
    dstChannel: number,
    srcChannel: number,
    /** Length of (any) data in the message */
    length: number,
}

interface WSMChannelContext {
    dstChannel: number,
    onOpen: (dstChannel: number) => void,
    onClose: (dstChannel: number) => void,
    onError: (err: Error) => void,
    onData: (data: Buffer) => void,
    onFlowControl: (stop: boolean) => void,
    bytesWritten: number,
    bytesRead: number,
    ackTimeout?: NodeJS.Timeout,
}

interface OpenOptions {
    /**
     * Connection timeout
     */
    timeout?: number,
    dstChannel?: number,
}

type ChannelInfo = {
    bytesWritten?: number,
    bytesRead?: number,
}

export interface WebSocketMultiplexOptions {
    reference?: string,
    /**
     * Max number of channels to multiplex over a single websocket.
     * Defaults to 65535
     */
    maxChannels?: number,
    /**
     * How often to send WebSocket ping to keep the underlying websocket alive.
     */
    keepAlive?: number,
    /**
     * When to consider the websocket peer to be dead, but be greater than
     * the keepAlive value.
     *
     * Defaults to keepAlive * 2
     */
    aliveThreshold?: number,
}

export class WebSocketMultiplex extends EventEmitter {
    public reference: string;
    private keepAlive: number;
    private aliveThreshold: number;
    private maxChannels: number;
    private openChannels: { [key: number]: WSMChannelContext };
    /* Hashmap remote -> local */
    private openRemoteChannels: { [key: number]: number };
    private socket: WebSocket;

    private socketPongFn: any;
    private lastPong: bigint;
    private aliveTimer: NodeJS.Timer;

    private socketCloseFn: any;
    private socketMessageFn: any;

    public closed: boolean = false;

    /**
     * Create a new websocket channel multiplexer
     *
     * @param socket Existing and open WebSocket for the channel multiplexer
     * @param options Channel multiplex options
     */
    constructor(socket: WebSocket, options?: WebSocketMultiplexOptions) {
        super();
        this.socket = socket;
        this.reference = options?.reference || "";
        this.keepAlive = options?.keepAlive || DEFAULT_KEEP_ALIVE;
        this.aliveThreshold = options?.aliveThreshold || this.keepAlive * 2;

        assert(this.aliveThreshold > this.keepAlive);

        this.maxChannels = options?.maxChannels || DEFAULT_MAX_OPEN_CHANNELS;
        this.openChannels = {};
        this.openRemoteChannels = {};

        this.socketPongFn = this.onPong.bind(this);
        this.socket.on("pong", this.socketPongFn);
        this.lastPong = process.hrtime.bigint();
        this.peerKeepAlive();
        this.aliveTimer = setInterval(() => { this.peerKeepAlive() }, this.keepAlive);

        this.socketCloseFn = () => {
            const error = new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WS_SOCKET_CLOSED_UNEXPECTEDLY);
            this.terminate(error);
        };
        this.socket.on("close", this.socketCloseFn);

        this.socketMessageFn = this.onMessage.bind(this);
        this.socket.on("message", this.socketMessageFn);
    }

    /**
     * Destroy the multiplex stream
     *
     * Closes all open channels and releases all allocated resources.
     *
     * @returns Promise<void>
     */
    public async destroy(): Promise<void> {
        return this.terminate(undefined);
    }

    /**
     * Open a new channel
     *
     * @param options Channel open options
     * @param onOpen Callback when channel is successfully opened.
     * @param onClose Callback when channel is closed.
     * @param onError Callback if an error occurs, will always be triggered before close.
     * @param onData Callback when data is received on the channel.
     * @param onFlowControl Callback on peer flow control
     * @returns [channel, error]
     */
    public open(options: OpenOptions,
                onOpen: (dstChannel: number) => void,
                onClose: (dstChannel: number) => void,
                onError: (err: Error) => void,
                onData: (data: Buffer) => void,
                onFlowControl: (stop: boolean) => void): [number, undefined] | [undefined, Error] {

        if (options.dstChannel != undefined && this.openRemoteChannels[options.dstChannel] != undefined) {
            return [undefined, new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_OPEN_CHANNEL_REUSE, `channel=${options.dstChannel}`)];
        }

        const [channel, err] = this.allocateChannel();
        if (err) {
            return [undefined, err];
        }

        this.openChannels[channel] = {
            dstChannel: 0,
            onOpen,
            onClose,
            onError,
            onData,
            onFlowControl,
            bytesWritten: 0,
            bytesRead: 0,
        };

        if (options.dstChannel == undefined) {
            this.sendMessage(WSMMessageType.MESSAGE_OPEN, 0, channel, undefined, (err?: Error) => {
                if (err) {
                    onError(err);
                    delete this.openChannels[channel];
                } else {
                    const timeout = options.timeout || DEFAULT_OPEN_TIMEOUT;
                    this.openChannels[channel].ackTimeout = setTimeout(() => {
                        onError(new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_OPEN_CHANNEL_TIMEOUT));
                        delete this.openChannels[channel];
                    }, timeout);
                }
            });
        } else {
            const dstChannel: number = options.dstChannel;
            this.openChannels[channel].dstChannel = dstChannel;
            this.openRemoteChannels[dstChannel] = channel;
            this.sendMessage(WSMMessageType.MESSAGE_ACK, dstChannel, channel, undefined, (err?: Error) => {
                if (err) {
                    onError(err);
                    this.close(channel);
                } else {
                    process.nextTick(() => {
                        onOpen(dstChannel);
                    });
                }
            });
        }

        return [channel, undefined];
    }

    /**
     * Close a previously open channel
     *
     * Returns true if the channel was closed, otherwise an error is returned.
     *
     * @param channel The channel to close
     * @returns [boolean, error]
     */
    public close(channel: number): [boolean, Error?] {
        const context = this.openChannels[channel];
        if (!context || context?.dstChannel == 0) {
            return [false, new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_NOT_OPEN)];
        }

        this.closeRemoteChannel(context.dstChannel, channel);
        this.closeLocalChannel(channel);

        return [true, undefined];
    }

    /**
     * Send data on an open channel
     *
     * @param channel Channel to send data on
     * @param data Data buffer to send
     * @param callback Completion callback
     * @returns Boolean true if the transmission was successfully started, otherwise false
     */
    public send(channel: number, data: Buffer | Array<Buffer>, callback?: (err?: Error) => void): boolean {
        const context = this.openChannels[channel];
        if (!context || context.dstChannel == 0) {
            const err = new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_NOT_OPEN);
            typeof callback == 'function' && process.nextTick(() => {callback(err)});
            return false;
        }

        return this.sendMessage(WSMMessageType.MESSAGE_DATA, context.dstChannel, channel, data, callback);
    }

    /**
     * Pause/resume data flow on a channel
     *
     * Stopping the stream instructs the remote peer to stop sending data frames, and to buffer
     * data until the stream is resumed.
     *
     * @param channel The channel to pause/resume
     * @param stop Stop data flow, or resume.
     * @param callback Completion callback.
     * @returns Boolean true if the flow control was successfully sent, otherwise false
     */
    public flowControl(channel: number, stop: boolean, callback?: (err?: Error) => void): boolean {
        const context = this.openChannels[channel];
        if (!context || context.dstChannel == 0) {
            const err = new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_NOT_OPEN);
            typeof callback == 'function' && process.nextTick(() => {callback(err)});
            return false;
        }

        if (stop) {
            return this.sendMessage(WSMMessageType.MESSAGE_PAUSE, context.dstChannel, channel, undefined, callback);
        } else {
            return this.sendMessage(WSMMessageType.MESSAGE_RESUME, context.dstChannel, channel, undefined, callback);
        }
    }

    /**
     * Create a socket connection
     *
     * @param options Connection options
     * @param connectCallback Callback on successful connection
     * @returns Instance of WebSocketMultiplexSocket
     */
    public createConnection(options: WebSocketMultiplexSocketOptions, connectCallback?: () => void): WebSocketMultiplexSocket {
        const sock = new WebSocketMultiplexSocket(this);
        return sock.connect(options, connectCallback);
    }

    /**
     * Returns channel info and statistics
     *
     * @returns ChannelInfo
     */
    public channelInfo(channel: number): ChannelInfo {
        const context = this.openChannels[channel];
        if (!context) {
            return {};
        }
        return {
            bytesWritten: context.bytesWritten,
            bytesRead: context.bytesRead,
        }
    }

    private peerLastAlive(): number {
        return Number((process.hrtime.bigint() - this.lastPong) / BigInt(1000000));
    }

    private async terminate(error: Error | undefined): Promise<void> {
        if (this.closed) {
            return;
        }
        const openChannels = [...Object.keys(this.openChannels)];
        for (let k of openChannels) {
            const channel = Number(k);
            const context = this.openChannels[channel];

            await new Promise((resolve) => {
                this.closeRemoteChannel(context.dstChannel, channel, undefined, resolve);
            });
            this.closeLocalChannel(channel);
        }
        this.closed = true;

        let listeners: number;

        clearInterval(this.aliveTimer);
        listeners = this.socket.listenerCount("close");
        this.socket.off("close", this.socketCloseFn);
        assert(this.socket.listenerCount("close") == Math.max((listeners - 1), 0), "close listener count");

        listeners = this.socket.listenerCount("pong");
        this.socket.off("pong", this.socketPongFn);
        assert(this.socket.listenerCount("pong") == Math.max((listeners - 1), 0), "pong listener count");

        listeners = this.socket.listenerCount("message");
        this.socket.off("message", this.socketMessageFn);
        assert(this.socket.listenerCount("message") == Math.max((listeners - 1), 0), "message listener count");

        if (error != undefined) {
            this.emit('error', error);
        }
        this.emit('close');
    }

    private onPong(): void {
        this.lastPong = process.hrtime.bigint();
    };

    private peerKeepAlive(): void {
        this.socket.ping();
        const lastMs = this.peerLastAlive();
        if (lastMs >= this.aliveThreshold) {
            this.terminate(new WebSocketMultiplexError(
                WebSocketMultiplexErrorCode.ERR_WS_PING_TIMEOUT,
                `No pong for ${lastMs} ms (threshold ${this.aliveThreshold} ms)`));
        }
    }

    private static decodeMessage(chunk: Buffer): [WSMMessage, undefined] | [undefined, Error] {
        try {
            const headerBuffer = chunk.subarray(0, 16);
            const header: WSMHeader = {
                version: headerBuffer.readUInt16BE(0),
                type: headerBuffer.readUInt16BE(2),
                dstChannel: headerBuffer.readUInt32BE(4),
                srcChannel: headerBuffer.readUInt32BE(8),
                length: headerBuffer.readUInt32BE(12),
            };
            const data = chunk.subarray(16);
            return [{header, data}, undefined];
        } catch (error: any) {
            return [undefined, error];
        }
    }

    private static encodeHeader(type: WSMMessageType, destChannel: number, sourceChannel: number, data?: Buffer | Array<Buffer>): [Buffer, number] {

        let dataLength: number = 0;
        if (data instanceof Array) {
            for (let i = 0; i < data.length; i++) {
                dataLength += data[i].length;
            }
        } else if (data != undefined) {
            dataLength = data.length;
        }

        const header = Buffer.allocUnsafe(16);
        header.writeUInt16BE(WSMVersion.VERSION_2, 0)
        header.writeUInt16BE(type, 2);
        header.writeUInt32BE(destChannel, 4);
        header.writeUInt32BE(sourceChannel, 8);
        header.writeUInt32BE(dataLength, 12);
        return [header, dataLength];
    }

    private sendMessage(type: WSMMessageType, destChannel: number, sourceChannel: number, data?: Buffer | Array<Buffer>, callback?: (err?: Error) => void): boolean {
        if (this.closed) {
            typeof callback == 'function' &&
                callback(new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WS_SOCKED_CLOSED));
            return false;
        }

        assert(type === WSMMessageType.MESSAGE_OPEN ? destChannel == 0 : true, `OPEN with non-zero dst channel`);

        const [header, dataLength] = WebSocketMultiplex.encodeHeader(type, destChannel, sourceChannel, data);
        try {
            this.socket.send(header, {
                binary: true,
                compress: false,
                fin: data == undefined,
            });

            if (data != undefined) {
                if (data instanceof Buffer) {
                    data = [data];
                }

                for (let i = 0; i < (data.length - 1); i++) {
                    this.socket.send(data[i], {
                        binary: true,
                        compress: false,
                        fin: false,
                    })
                }
                this.socket.send(data[data.length - 1], {
                    binary: true,
                    compress: false,
                    fin: true
                }, callback);

                if (type == WSMMessageType.MESSAGE_DATA) {
                    this.openChannels[sourceChannel].bytesWritten += dataLength;
                }
            } else {
                typeof callback == 'function' && callback();
            }
            return true;
        } catch (err: any) {
            typeof callback == 'function' && callback(err);
            return false;
        }
    }

    private onMessage(message: Buffer): void {
        const [WSMm, err] = WebSocketMultiplex.decodeMessage(message);
        if (err) {
            return;
        }

        if (WSMm.header.version != WSMVersion.VERSION_2) {
            this.terminate(new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_UNSUPPORTED_PROTOCOL_VERSION));
            return;
        }

        switch (WSMm.header.type) {
            case WSMMessageType.MESSAGE_DATA:
                return this.handleDataMessage(WSMm);
            case WSMMessageType.MESSAGE_OPEN:
                return this.handleOpenMessage(WSMm);
            case WSMMessageType.MESSAGE_CLOSE:
                return this.handleCloseMessage(WSMm);
            case WSMMessageType.MESSAGE_ACK:
                return this.handleAckMessage(WSMm);
            case WSMMessageType.MESSAGE_PAUSE:
                return this.handlePauseMessage(WSMm);
            case WSMMessageType.MESSAGE_RESUME:
                return this.handleResumeMessage(WSMm);
            default:
                break;
        }
    }

    private allocateChannel(): [number, undefined] | [undefined, Error] {
        const openChannels = Object.keys(this.openChannels).sort();

        if (openChannels.length >= this.maxChannels) {
            return [undefined, new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_NO_CHANNELS)];
        }

        let channel =
            ((openChannels.length == 0 ? 0 : (Number(openChannels[openChannels.length - 1])))
                % CHANNEL_MAX) + 1;

        for (let i = 0; this.openChannels[channel] != undefined && i < this.maxChannels; i++) {
            channel = channel + 1
        }

        assert(channel >= CHANNEL_MIN && channel <= CHANNEL_MAX, `channel ${channel} not within rage`);
        assert(this.openChannels[channel] == undefined, `allocated busy channel ${channel}`);

        return [channel, undefined];
    }


    private closeRemoteChannel(dstChannel: number, srcChannel?: number, err?: Error, callback?: (err?: Error) => void): boolean {
        let errorBuffer = undefined;
        if (err instanceof WebSocketMultiplexError) {
            errorBuffer = Buffer.from(err.code);
        } else if (err instanceof Error) {
            errorBuffer = Buffer.from(err.message)
        }

        return this.sendMessage(WSMMessageType.MESSAGE_CLOSE, dstChannel, srcChannel ?? 0, errorBuffer, (sendErr) => {
            delete this.openRemoteChannels[dstChannel];
            if (srcChannel && this.openChannels[srcChannel]) {
                this.openChannels[srcChannel].dstChannel = 0;
            }

            typeof callback == 'function' && callback(sendErr);
        });
    }

    private closeLocalChannel(channel: number, err?: Error): void {
        const context = this.openChannels[channel];
        if (context) {
            clearTimeout(context.ackTimeout);
            if (err) {
                context.onError(err);
            }
            context.onClose(channel);
            if (context.dstChannel > 0) {
                delete this.openRemoteChannels[context.dstChannel];
            }
        }
        delete this.openChannels[channel];
    }

    private handleAckMessage(WSMm: WSMMessage): void {
        const context = this.openChannels[WSMm.header.dstChannel];
        if (context == undefined) {
            this.closeRemoteChannel(WSMm.header.srcChannel, undefined, new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_NOT_OPEN));
            return;
        }

        context.dstChannel = WSMm.header.srcChannel;
        this.openRemoteChannels[WSMm.header.srcChannel] = WSMm.header.dstChannel;
        clearTimeout(context.ackTimeout);
        delete context.ackTimeout;
        context.onOpen(WSMm.header.srcChannel);
    }

    private handleOpenMessage(WSMm: WSMMessage): void {
        const sock = new WebSocketMultiplexSocket(this);
        try {
            sock.connect({
                dstChannel: WSMm.header.srcChannel
            }, () => {
                this.emit('connection', sock);
            });
        } catch (err: any) {
            this.closeRemoteChannel(WSMm.header.srcChannel, undefined, err);
            const channel = this.openRemoteChannels[WSMm.header.srcChannel];
            if (channel) {
                this.closeLocalChannel(channel, err)
            }
        }
    }

    private handleCloseMessage(WSMm: WSMMessage): void {
        const context = this.openChannels[WSMm.header.dstChannel];

        let closeErr;
        if (WSMm.data.length > 0) {
            const errorStr = WSMm.data.toString("utf-8");
            closeErr = WebSocketMultiplexError.from(errorStr) || new Error(errorStr);
        }

        let err;
        if (context?.ackTimeout) {
            clearTimeout(context.ackTimeout);
            delete context.ackTimeout;

            err = new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_OPEN_CHANNEL_REJECTED,
                closeErr?.message);
            err.remote = closeErr;
        } else if (closeErr) {
            err = new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_CLOSED_BY_PEER,
                closeErr.message);
            err.remote = closeErr;
        }
        this.closeLocalChannel(WSMm.header.dstChannel, err);
    }

    private handleDataMessage(WSMm: WSMMessage): void {
        const context = this.openChannels[WSMm.header.dstChannel];
        if (context == undefined) {
            this.closeRemoteChannel(WSMm.header.srcChannel, undefined,
                new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_NOT_OPEN));
            return;
        } else if (this.openRemoteChannels[WSMm.header.srcChannel] != context.dstChannel) {
            const err =
                new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_MISMATCH,
                    `src=${WSMm.header.srcChannel} dst=${context.dstChannel}`);

            this.closeRemoteChannel(context.dstChannel, WSMm.header.dstChannel, err);
            this.closeLocalChannel(WSMm.header.dstChannel, err);

            const second = this.openRemoteChannels[WSMm.header.srcChannel];
            const secondContext = this.openChannels[second];
            if (secondContext) {
                this.closeRemoteChannel(secondContext.dstChannel, second, err);
                this.closeLocalChannel(second, err);
            }
            return;
        }
        context.bytesRead += WSMm.data.length;
        context.onData(WSMm.data);
    }

    private handlePauseMessage(WSMm: WSMMessage): void {
        const context = this.openChannels[WSMm.header.dstChannel];
        if (context == undefined) {
            this.closeRemoteChannel(WSMm.header.srcChannel, undefined,
                new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_NOT_OPEN));
            return;
        }
        context.onFlowControl(true);
    }

    private handleResumeMessage(WSMm: WSMMessage): void {
        const context = this.openChannels[WSMm.header.dstChannel];
        if (context == undefined) {
            this.closeRemoteChannel(WSMm.header.srcChannel, undefined,
                new WebSocketMultiplexError(WebSocketMultiplexErrorCode.ERR_WSM_CHANNEL_NOT_OPEN));
            return;
        }
        context.onFlowControl(false);
    }

}