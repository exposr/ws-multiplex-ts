export enum WebSocketMultiplexErrorCode {
    /**
     * No pong reply from underlying websocket peer within
     * the alive threshold.
     */
    ERR_WS_PING_TIMEOUT = "ERR_WS_PING_TIMEOUT",
    /**
     * The underlying websocket was closed prior to ending
     * the multiplex socket.
     */
    ERR_WS_SOCKET_CLOSED_UNEXPECTEDLY = "ERR_WS_SOCKET_CLOSED_UNEXPECTEDLY",
    /**
     * Operation on a underlying closed websocket
     */
    ERR_WS_SOCKED_CLOSED = "ERR_WS_SOCKED_CLOSED",

    /**
     * Unsupported WSM protocol version
     */
    ERR_WSM_UNSUPPORTED_PROTOCOL_VERSION = "ERR_WSM_UNSUPPORTED_PROTOCOL_VERSION",

    /**
     * No channels available 
     */
    ERR_WSM_NO_CHANNELS = "ERR_WSM_NO_CHANNELS",

    /**
     * Channel open timeout
     */
    ERR_WSM_OPEN_CHANNEL_TIMEOUT = "ERR_WSM_OPEN_CHANNEL_TIMEOUT",

    /**
     * Channel open was rejected by peer 
     */
    ERR_WSM_OPEN_CHANNEL_REJECTED = "ERR_WSM_OPEN_CHANNEL_REJECTED",

    /**
     * Operation on closed channel
     */
    ERR_WSM_CHANNEL_NOT_OPEN = "ERR_WSM_CHANNEL_NOT_OPEN",

    /**
     * Channel closed by remote peer
     */
    ERR_WSM_CHANNEL_CLOSED_BY_PEER = "ERR_WSM_CHANNEL_CLOSED_BY_PEER",

    /**
     * Channel number was reused while open
     */
    ERR_WSM_OPEN_CHANNEL_REUSE = "ERR_WSM_OPEN_CHANNEL_REUSE",

    /**
     * The source channel does not match the source channel 
     * during open/ack.
     */
    ERR_WSM_CHANNEL_MISMATCH = "ERR_WSM_CHANNEL_MISMATCH",
}

const WebSocketMultiplexErrorMessage: { [key in WebSocketMultiplexErrorCode ]: string } = {
    ERR_WS_PING_TIMEOUT: "No pong received from peer within alive threshold",
    ERR_WS_SOCKET_CLOSED_UNEXPECTEDLY: "Websocket closed unexpectedly",
    ERR_WS_SOCKED_CLOSED: "Operation on closed websocket",
    ERR_WSM_UNSUPPORTED_PROTOCOL_VERSION: "Unsupported websocket multiplex protocol version",
    ERR_WSM_NO_CHANNELS: "Maximum number of open channels reached",
    ERR_WSM_OPEN_CHANNEL_TIMEOUT: "Timeout opening channel, no ACK received",
    ERR_WSM_OPEN_CHANNEL_REJECTED: "Request to open channel rejected by peer",
    ERR_WSM_CHANNEL_NOT_OPEN: "Operation on closed channel",
    ERR_WSM_CHANNEL_CLOSED_BY_PEER: "Channel closed by remote peer",
    ERR_WSM_OPEN_CHANNEL_REUSE: "Attempted channel reuse while still open",
    ERR_WSM_CHANNEL_MISMATCH: "Channel mismatch",
};

export class WebSocketMultiplexError extends Error {
    public remote?: Error; 
    public readonly code: string;

    constructor(code: WebSocketMultiplexErrorCode, message?: string) {
        let msg: string = code + ": " + WebSocketMultiplexErrorMessage[code];
        if (message) {
            msg += ` (${message})`;
        }
        super(msg);
        this.code = code;
    }

    static from(str: string): WebSocketMultiplexError | undefined {
        try {
            const code = str as keyof typeof WebSocketMultiplexErrorCode;
            return new WebSocketMultiplexError(WebSocketMultiplexErrorCode[code]);
        } catch (e) {
            return undefined;
        }
    }
}