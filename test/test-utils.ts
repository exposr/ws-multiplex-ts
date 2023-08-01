import { WebSocket, WebSocketServer } from 'ws';
import { WebSocketMultiplex, WebSocketMultiplexOptions } from '../src/ws-multiplex';

export class wsSocketPair {
    public sock1: WebSocket;
    public sock2: WebSocket;
    public wss: WebSocketServer;

    static async create(port: number = 10000): Promise<wsSocketPair> {

        const [server, sock] = await Promise.all([
            new Promise((resolve, reject) => {
                const wss = new WebSocketServer({ port });
                wss.on('error', () => { });
                wss.on('connection', function connection(client) {
                    resolve([client, wss]);
                });

            }),
            new Promise((resolve, reject) => {
                let sock: WebSocket;
                sock = new WebSocket(`ws://127.0.0.1:${port}`);
                sock.once('error', reject);
                sock.once('open', () => {
                    sock.off('error', reject);
                    resolve(sock);
                });
            })
        ]);
        const [client, wss] = (server as Array<object>);

        const socketPair = new wsSocketPair(sock as WebSocket, client as WebSocket, wss as WebSocketServer);
        return socketPair;
    }

    private constructor(sock1: WebSocket, sock2: WebSocket, wss: WebSocketServer) {
        this.sock1 = sock1;
        this.sock2 = sock2;
        this.wss = wss;
    }

    async terminate(): Promise<void> {
        this.sock1?.terminate();
        this.sock2?.terminate();
        await new Promise((resolve) => { this.wss.close(resolve); });
    }

    public async getMessageSock1(): Promise<any> {
        return wsSocketPair.getRawResponse(this.sock1, true);
    }

    public async getMessageSock2(): Promise<any> {
        return wsSocketPair.getRawResponse(this.sock2, true);
    }

    public static async getRawResponse(sock: WebSocket, decode: boolean = false): Promise<any> {
        return new Promise((resolve: (msg: any) => void) => {
            sock.once("message", (data) => {
                const raw: Buffer = <Buffer>data;
                if (decode) {
                    const [msg, err] = WebSocketMultiplex['decodeMessage'](raw);
                    resolve([msg, err]);
                } else {
                    resolve(raw);
                }
            });
        });
    }
}
export const wsmPair = (socketPair: wsSocketPair, options?: WebSocketMultiplexOptions): Array<WebSocketMultiplex> => {
    const wsm1 = new WebSocketMultiplex(socketPair.sock1, {
        ...options,
        reference: "wsm1"
    });
    const wsm2 = new WebSocketMultiplex(socketPair.sock2, {
        ...options,
        reference: "wsm2"
    });
    return [wsm1, wsm2];
};
