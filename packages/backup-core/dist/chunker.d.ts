export interface ChunkerParams {
    min: number;
    avg: number;
    max: number;
}
export declare const DEFAULT_CHUNKER: ChunkerParams;
export declare function checkChunker({ min, avg, max }: ChunkerParams): void;
export declare function gearTable(cutKey: Buffer): Uint32Array;
export declare function cutPoint(data: Uint8Array, length: number, last: boolean, params: ChunkerParams, gear: Uint32Array): number;
export declare function chunkStream(source: AsyncIterable<Uint8Array>, params: ChunkerParams, gear: Uint32Array): AsyncGenerator<Buffer>;
