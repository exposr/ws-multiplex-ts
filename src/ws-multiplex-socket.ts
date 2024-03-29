import { Duplex } from 'node:stream';
import { WebSocketMultiplex } from './ws-multiplex';
import { SocketReadyState } from 'node:net';
import { AddressInfo, SocketConnectOpts } from 'net';
import assert from 'node:assert';
import { WebSocketMultiplexError } from '.';

const WSMErrorMapper: { [key: string]: string } = {
    'ERR_WS_PING_TIMEOUT': "ERR_WS_PING_TIMEOUT",
    'ERR_WS_SOCKET_CLOSED_UNEXPECTEDLY': "ERR_WS_SOCKET_CLOSED_UNEXPECTEDLY",
    'ERR_WS_SOCKED_CLOSED': "ERR_WS_SOCKED_CLOSED",
    'ERR_WSM_UNSUPPORTED_PROTOCOL_VERSION': "ERR_WSM_UNSUPPORTED_PROTOCOL_VERSION",
    'ERR_WSM_NO_CHANNELS': "EMFILE",
    'ERR_WSM_OPEN_CHANNEL_TIMEOUT': "ERR_SOCKET_CONNECTION_TIMEOUT",
    'ERR_WSM_OPEN_CHANNEL_REJECTED': "ECONNREFUSED",
    'ERR_WSM_CHANNEL_NOT_OPEN': "ERR_SOCKET_CLOSED",
    'ERR_WSM_CHANNEL_CLOSED_BY_PEER': "ECONNRESET",
    'ERR_WSM_OPEN_CHANNEL_REUSE': "EADDRINUSE",
    'ERR_WSM_CHANNEL_MISMATCH': "ERR_WSM_CHANNEL_MISMATCH",
};

export type WebSocketMultiplexSocketOptions = {
    /**
     * Connection timeout
     *
     * How long to wait for reply to a channel open request.
     */
    timeout?: number,

    /**
     * Create a socket for an already established remote channel.
     */
    dstChannel?: number,
}

export class WebSocketMultiplexSocket extends Duplex {
    private _ref: number;
    private wsm: WebSocketMultiplex;
    private channel: number;
    private dstChannel?: number;
    private constructCallback: ((error?: Error | null | undefined) => void) | undefined;
    private readBuffer: Array<Buffer>;
    private readBufferSize: number;
    private wantData: boolean = false;

    private writeBuffer: Array<{ channel: number, data: Buffer | Array<Buffer>, callback: (error?: Error) => void }>;
    private writer: (channel: number, data: Buffer | Array<Buffer>, callback: (error?: Error) => void) => void;

    public connecting: boolean;
    public pending: boolean;
    public readyState: SocketReadyState;
    public bytesWritten?: number;
    public bytesRead?: number;
    public bufferSize: number;
    public timeout?: number;
    private timeoutTimer?: NodeJS.Timeout;

    private _destroyed: boolean;

    constructor(wsm: WebSocketMultiplex) {
        super({
            defaultEncoding: 'binary',
            allowHalfOpen: false,
        });

        this._ref = 1;
        this.wsm = wsm;
        this.channel = 0;
        this.bufferSize = 0;
        this._destroyed = false;
        this.connecting = false;
        this.pending = true;
        this.readyState = "closed";
        this.constructCallback = undefined;
        this.readBuffer = [];
        this.readBufferSize = 0;
        this.writeBuffer = [];
        this.writer = this.bufferedWrite;

        Object.defineProperty(this, "bytesWritten", {
            get() {
                return this.wsm.channelInfo(this.channel)?.bytesWritten || 0;
            }
        });

        Object.defineProperty(this, "bytesRead", {
            get() {
                return this.wsm.channelInfo(this.channel)?.bytesRead || 0;
            }
        });
    }

    private onOpen(dstChannel: number): void {
        this.dstChannel = dstChannel;

        this.connecting = false;
        this.pending = false;
        this.readyState = "open";

        this.flushWriteBuffer();
        this.writer = this.wsm.send.bind(this.wsm);

        typeof this.constructCallback == 'function' && this.constructCallback();

        this.emit('connect');
        this.emit('ready');
        this.resetTimeout();
    }

    private onClose(dstChannel: number): void {
        this.end(() => {
            this.destroy()
        });
    }

    private onData(data: Buffer): void {
        this.readBuffer.push(data);
        this.readBufferSize += data.length;
        if (this.wantData) {
            this.flush();
        }
        if (this.readBufferSize > this.readableHighWaterMark) {
            this.wsm.flowControl(this.channel, true, (err) => {
                if (err) {
                    this.emit('error', err);
                }
            });
        }
        this.resetTimeout();
    }

    private onFlowControl(stop: boolean): void {
        if (stop) {
            this.cork();
        } else {
            this.uncork();
        }
    }

    private onError(err: Error): void {
        if (this._destroyed) {
            return;
        }

        const wsmErr: WebSocketMultiplexError = <WebSocketMultiplexError>err;
        this.emit("error", WebSocketMultiplexError.from(wsmErr, WSMErrorMapper[wsmErr.code]));
    }

    public connect(options: WebSocketMultiplexSocketOptions, connectCallback?: () => void): this;
    public connect(options: SocketConnectOpts, connectionListener?: (() => void) | undefined): this;
    public connect(port: number, host: string, connectionListener?: (() => void) | undefined): this;
    public connect(port: number, connectionListener?: (() => void) | undefined): this;
    public connect(path: string, connectionListener?: (() => void) | undefined): this;
    public connect(port: unknown, host?: unknown, connectionListener?: unknown): this {
        const options = typeof port == 'object' ? (port as WebSocketMultiplexSocketOptions) : {};

        this.readyState = "opening";
        this.connecting = true;

        const connectionCallback = typeof host == 'function' ?
            (host as () => void) :
            (typeof connectionListener == 'function' ? (connectionListener as () => void) : undefined);
        typeof connectionCallback == 'function' && this.once('connect', connectionCallback);

        const [channel, err] = this.wsm.open(
            {
                dstChannel: options.dstChannel,
                timeout: options.timeout,
            },
            this.onOpen.bind(this),
            this.onClose.bind(this),
            this.onError.bind(this),
            this.onData.bind(this),
            this.onFlowControl.bind(this),
        );

        if (err) {
            this.emit('error', err);
            return this;
        }
        this.channel = channel;

        return this;
    }

    _construct(callback: (error?: Error | null | undefined) => void): void {
        this.constructCallback = callback;
    }

    _destroy(error: Error | null, callback: (error: Error | null) => void): void {
        if (this._destroyed) {
            callback(error);
            return;
        }
        clearTimeout(this.timeoutTimer);
        this._destroyed = true;
        this.readyState = "closed";
        this.wsm.close(this.channel);
        typeof callback === 'function' && callback(error);
    }

    public resetAndDestroy(): this {
        return this.destroy();
    }

    public address(): {} | AddressInfo {
        return {};
    }

    public ref(): this {
        this._ref++;
        return this;
    }

    public unref(): this {
        this._ref--;
        if (this._ref == 0) {
            this.removeAllListeners('timeout');
        }
        return this;
    }

    private bufferedWrite(channel: number, data: Buffer | Array<Buffer>, callback: (error?: Error) => void): void {
        this.writeBuffer.push({channel, data, callback});
    }

    private flushWriteBuffer(): void {
        while (true) {
            const buffer = this.writeBuffer.shift();
            if (!buffer) {
                break;
            }
            this.wsm.send(buffer.channel, buffer.data, buffer.callback);
        }
    }

    _write(data: Buffer, encoding: BufferEncoding, callback: (error?: Error) => void): void {
        assert(this._destroyed == false, "_write on destroyed");
        this.writer(this.channel, data, callback);
        this.resetTimeout();
    }

    _writev(chunks: Array<{ chunk: any; encoding: BufferEncoding; }>, callback: (error?: Error) => void): void {
        assert(this._destroyed == false, "_writev on destroyed");
        const buffers: Array<Buffer> = [];
        for (const item of chunks) {
            buffers.push(item.chunk)
        }
        this.writer(this.channel, buffers, callback);
        this.resetTimeout();
    }

    private flush(): void {
        try {
            while (true) {
                const data = this.readBuffer.shift();
                if (!data) {
                    break;
                }
                this.readBufferSize -= data.length;
                const res = this.push(data);
                this.wantData = res;
                if (!res) {
                    break;
                }
            }
        } catch (err: any) {
            this.destroy(err);
        }
    }

    _read(size: number): void {
        this.wantData = true;
        if (this.readBufferSize > 0) {
            this.flush();
        }

        this.wsm.flowControl(this.channel, false);
    }

    public setEncoding(encoding: BufferEncoding): this {
        super.setEncoding(encoding);
        return this;
    }

    public setKeepAlive(enable: boolean, initialDelay: number): this {
        if (enable) {
            this.setTimeout(0);
        }
        return this;
    }

    public setNoDelay(noDelay: boolean): this {
        return this;
    }

    private resetTimeout(): void {
        clearTimeout(this.timeoutTimer);
        if (this.timeout != undefined && this.timeout > 0) {
            this.timeoutTimer = setTimeout(() => {
                this.emit('timeout');
            }, this.timeout);
        }
    }

    public setTimeout(timeout: number, callback?: () => void | undefined): this {
        this.timeout = timeout;
        typeof callback == 'function' && this.once('timeout', callback);
        if (this.readyState == 'open') {
            this.resetTimeout();
        }
        return this;
    }
}