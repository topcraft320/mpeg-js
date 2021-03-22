// ISO/IEC 13818-1 PES packets containing private data (stream_type=0x06)
export class PESPrivateData {
    data: Uint8Array;
    len: number;
    pid: number;
    pts: number;
    dts: number;
}
