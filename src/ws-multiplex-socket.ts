import { Duplex } from 'node:stream';
import { WebSocketMultiplex } from './ws-multiplex';
import { SocketReadyState } from 'node:net';
import { AddressInfo, SocketConnectOpts } from 'net';

enum WebSocketMultiplexSocketState {
    CONNECTING = 'CONNECTING',
    PENDING = 'PENDING',
    PAUSED = 'PAUSED',
    OPEN = 'OPEN',
    HALFOPEN = 'HALFOPEN',
    ENDED = 'ENDED',
}

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
    private state: WebSocketMultiplexSocketState;
    private WSM: WebSocketMultiplex;
    private channel: number;
    private dstChannel?: number;
    private onDataListener?: (name: string) => void;
    private onPipeListener?: (name: string) => void;

    public connecting: boolean;
    public pending: boolean;
    public readyState: SocketReadyState;
    public destroyed: boolean;
    public bytesWritten: number;
    public bytesRead: number;
    public bufferSize: number;

    constructor(WSM: WebSocketMultiplex) {
        super({
            defaultEncoding: 'binary'
        });

        this.WSM = WSM;
        this.channel = 0;
        this.bytesWritten = 0;
        this.bytesRead = 0;
        this.bufferSize = 0;
        this.destroyed = false;
        this.connecting = false;
        this.pending = true;
        this.readyState = "closed";
        this.state = WebSocketMultiplexSocketState.PENDING;
    }

    private clearAutoResumeTriggers(): void {
        if (this.onDataListener) {
            this.off('newListener', this.onDataListener);
            this.onDataListener = undefined;
        }
        if (this.onPipeListener) {
            this.off('pipe', this.onPipeListener);
            this.onPipeListener = undefined;
        }
    }

    private onOpen(dstChannel: number): void {
        this.dstChannel = dstChannel;

        this.state = WebSocketMultiplexSocketState.OPEN;
        this.connecting = false;
        this.pending = false;
        this.readyState = "open";

        if (this.listenerCount('data') == 0) {
            this.pause();
            this.onDataListener = (name: string) => {
                if (name == 'data') {
                    this.resume();
                }
            };
            this.onPipeListener = () => {
                this.resume();
            };

            this.once('pipe', this.onPipeListener);
            this.on('newListener', this.onDataListener);
        }

        this.emit('connect');
        this.emit('ready');
    }

    private onClose(dstChannel: number): void {
        this.end(() => {
            this.destroy()
        });
    }

    private onData(data: Buffer): void {
        const result = this.push(data);
        if (!result) {
            this.pause();
        }
    }

    private onFlowControl(stop: boolean): void {
        if (stop) {
            this.cork();
        } else {
            this.uncork();
        }
    }

    private onError(err: Error): void {
        if (this.destroyed) {
            return;
        }
        this.emit("error", err);
    }

    public connect(options: WebSocketMultiplexSocketOptions, connectCallback?: () => void): this;
    public connect(options: SocketConnectOpts, connectionListener?: (() => void) | undefined): this;
    public connect(port: number, host: string, connectionListener?: (() => void) | undefined): this;
    public connect(port: number, connectionListener?: (() => void) | undefined): this;
    public connect(path: string, connectionListener?: (() => void) | undefined): this;
    public connect(port: unknown, host?: unknown, connectionListener?: unknown): this {
        const options = typeof port == 'object' ? (port as WebSocketMultiplexSocketOptions) : {};

        this.state = WebSocketMultiplexSocketState.CONNECTING;
        this.readyState = "opening";
        this.connecting = true;

        const connectionCallback = typeof host == 'function' ?
            (host as () => void) :
            (typeof connectionListener == 'function' ? (connectionListener as () => void) : undefined);
        typeof connectionCallback == 'function' && this.once('connect', connectionCallback);

        const [channel, err] = this.WSM.open(
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
            throw err;
        }
        this.channel = channel;

        return this;
    }

    _destroy(error: Error | null, callback: (error: Error | null) => void): void {
        if (this.destroyed) {
            typeof callback === 'function' && callback(error);
            return;
        }
        this.destroyed = true;
        this.readyState = "closed";
        this.state = WebSocketMultiplexSocketState.ENDED;
        this.WSM.close(this.channel);
        typeof callback === 'function' && callback(error);
    }

    public resetAndDestroy(): this {
        return this.destroy();
    }

    public address(): {} | AddressInfo {
        return {};
    }

    public ref(): this {
        return this;
    }

    public unref(): this {
        return this;
    }

    public end(cb?: () => void): this;
    public end(chunk: any, cb?: () => void): this;
    public end(chunk: any, encoding?: BufferEncoding, cb?: () => void): this;

    public end(chunkOrCb?: any | (() => void), encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): this {
        let encoding = typeof encodingOrCb == 'function' ? undefined : encodingOrCb;
        let chunk = typeof chunkOrCb == 'function' ? undefined : chunkOrCb;
        let callback = typeof chunkOrCb == 'function' ? chunkOrCb :
            (typeof encodingOrCb == 'function' ? encodingOrCb : cb);

        super.end(chunk, encoding, () => {
            if (this.destroyed) {
                typeof callback === 'function' && callback();
                return;
            }
            this.readyState = "readOnly";
            this.state = WebSocketMultiplexSocketState.HALFOPEN;
            this.WSM.close(this.channel);
            typeof callback === 'function' && callback();
        });

        return this;
    }

    public push(chunk: Buffer, encoding?: BufferEncoding): boolean {
        this.bytesRead += chunk.length;
        return super.push(chunk, encoding);
    }

    public pause(): this {
        if (this.state === WebSocketMultiplexSocketState.OPEN) {
            this.state = WebSocketMultiplexSocketState.PAUSED;
            super.pause();
            this.WSM.flowControl(this.channel, true, (err) => {
                if (err) {
                    this.emit('error', err);
                }
            });
        } else {
            super.pause();
        }
        return this;
    }

    public resume(): this {
        this.clearAutoResumeTriggers();
        if (this.state === WebSocketMultiplexSocketState.PAUSED) {
            this.state = WebSocketMultiplexSocketState.OPEN;
            super.resume();
            this.WSM.flowControl(this.channel, false, (err) => {
                if (err) {
                    this.emit('error', err);
                }
            });
        } else if (this.state === WebSocketMultiplexSocketState.OPEN) {
            super.resume();
        }
        return this;
    }

    public cork(): void {
        super.cork();
    }

    public uncork(): void {
        super.uncork();
    }

    _write(data: Buffer, encoding: BufferEncoding, callback: (error?: Error) => void): void {
        this.bytesWritten += data.length;
        this.WSM.send(<number>this.channel, data, callback);
    }

    _writev(chunks: Array<{ chunk: any; encoding: BufferEncoding; }>, callback: (error?: Error) => void): void {
        for (const {chunk, encoding} of chunks) {
            this._write(chunk, encoding, (err?: Error) => {
                if (err) {
                    return callback(err);
                }
            });
        }
        return callback();
    }

    _read(size: number): void {
    }

    public setEncoding(encoding: BufferEncoding): this {
        super.setEncoding(encoding);
        return this;
    }

    public setKeepAlive(enable: boolean, initialDelay: number): this {
        return this;
    }

    public setNoDelay(noDelay: boolean): this {
        return this;
    }

    public setTimeout(timeout: number, callback: () => void): this {
        return this;
    }
}