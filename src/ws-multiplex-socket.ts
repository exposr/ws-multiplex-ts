import { Duplex } from 'node:stream';
import { WebSocketMultiplex } from './ws-multiplex';
import { SocketReadyState } from 'node:net';
import { AddressInfo, SocketConnectOpts } from 'net';

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
    private WSM: WebSocketMultiplex;
    private channel: number;
    private dstChannel?: number;
    private onDataListener?: (name: string) => void;
    private onPipeListener?: (name: string) => void;
    private openBuffer: Array<{data: Array<Buffer>, cb: (err?: Error) => void}> = [];

    public connecting: boolean;
    public pending: boolean;
    public readyState: SocketReadyState;
    public destroyed: boolean;
    public bytesWritten?: number;
    public bytesRead?: number;
    public bufferSize: number;

    constructor(WSM: WebSocketMultiplex) {
        super({
            defaultEncoding: 'binary'
        });

        this.WSM = WSM;
        this.channel = 0;
        this.bufferSize = 0;
        this.destroyed = false;
        this.connecting = false;
        this.pending = true;
        this.readyState = "closed";

        Object.defineProperty(this, "bytesWritten", {
            get() {
                return this.WSM.channelInfo(this.channel)?.bytesWritten || 0;
            }
        });

        Object.defineProperty(this, "bytesRead", {
            get() {
                return this.WSM.channelInfo(this.channel)?.bytesRead || 0;
            }
        });
    }

    private onOpen(dstChannel: number): void {
        this.dstChannel = dstChannel;

        this.connecting = false;
        this.pending = false;
        this.readyState = "open";

        for (let i = 0; i < this.openBuffer.length; i++) {
            const {data, cb} = this.openBuffer[i];
            this.WSM.send(<number>this.channel, data, cb);
        }
        this.openBuffer = [];

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
            this.WSM.flowControl(this.channel, true, (err) => {
                if (err) {
                    this.emit('error', err);
                }
            });
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

        this.openBuffer = [];
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
            typeof callback === 'function' && callback();
        });

        return this;
    }

    private wsmWrite(data: Buffer | Array<Buffer>, cb: (error?: Error) => void): boolean {
        if (this.readyState == "opening") {
            if (data instanceof Buffer) {
                data = [data];
            }
            this.openBuffer.push({data, cb});
            return true;
        } else {
            return this.WSM.send(<number>this.channel, data, cb);
        }
    }

    _write(data: Buffer, encoding: BufferEncoding, callback: (error?: Error) => void): void {
        this.wsmWrite(data, callback);
    }

    _writev(chunks: Array<{ chunk: any; encoding: BufferEncoding; }>, callback: (error?: Error) => void): void {
        const buffers: Array<Buffer> = [];
        for (const item of chunks) {
            buffers.push(item.chunk)
        }
        this.wsmWrite(buffers, callback);
    }

    _read(size: number): void {
        if (this.readyState != "open") {
            return;
        }
        this.WSM.flowControl(this.channel, false, (err) => {
            if (err) {
                this.emit('error', err);
            }
        });
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