import { describe, expect, test } from 'bun:test';
import { CaptionClock, since, WRAP } from './caption-clock';
import { PACKET } from './psi';
import { packetize, patSection, programMap } from './synth';

const SERVICE = 1024;
const PMT_PID = 0x1f0;
const VIDEO_PID = 0x100;
const CAPTION_PID = 0x130;
const SUPER_PID = 0x138;

/** 部品タグの記述子。0x30〜0x37 が字幕、0x38〜 が文字スーパー */
const componentTag = (tag: number) => [0x52, 0x01, tag];

const pat = () => packetize(0x0000, patSection([[SERVICE, PMT_PID]]));

const pmt = () =>
    packetize(
        PMT_PID,
        programMap(SERVICE, VIDEO_PID, [
            [0x02, VIDEO_PID],
            [0x0f, 0x110],
            [0x06, CAPTION_PID, componentTag(0x30)],
            [0x06, SUPER_PID, componentTag(0x38)],
        ]),
    );

/** 時刻を持つ PES の頭。字幕は private_stream_1 で流れてくる */
function pesPacket(pid: number, pts: number): Uint8Array {
    const out = new Uint8Array(PACKET).fill(0xff);
    out[0] = 0x47;
    out[1] = 0x40 | ((pid >> 8) & 0x1f);
    out[2] = pid & 0xff;
    out[3] = 0x10;
    const pes = out.subarray(4);
    pes[0] = 0x00;
    pes[1] = 0x00;
    pes[2] = 0x01;
    pes[3] = 0xbd;
    pes[4] = 0x00;
    pes[5] = 0x20;
    pes[6] = 0x80;
    pes[7] = 0x80;
    pes[8] = 0x05;
    pes[9] = 0x21 | ((pts / 536870912) & 0x0e);
    pes[10] = (pts / 4194304) & 0xff;
    pes[11] = 0x01 | ((pts / 16384) & 0xfe);
    pes[12] = (pts / 128) & 0xff;
    pes[13] = 0x01 | ((pts * 2) & 0xfe);
    return out;
}

const join = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

/**
 * **字幕には「いつ出すか」が乗っている。** その時刻をそのまま読み出せれば、
 * 受け側は合わせにいく必要が無い (`server/live.ts` の `attend` が原点を引く)。
 */
describe('CaptionClock', () => {
    const started = () => {
        const clock = new CaptionClock();
        clock.feed(join(pat(), pmt()));
        return clock;
    };

    test('字幕の時刻を読む', () => {
        const clock = started();
        clock.feed(pesPacket(CAPTION_PID, 90000 * 7));
        expect(clock.latest).toBe(90000 * 7);
    });

    /** 出すのは**いちばん最近届いたもの**。絵は届いた端から出てくる */
    test('新しいほうで上書きする', () => {
        const clock = started();
        clock.feed(pesPacket(CAPTION_PID, 100));
        clock.feed(pesPacket(CAPTION_PID, 200));
        expect(clock.latest).toBe(200);
    });

    /**
     * **文字スーパーは採らない。** あちらは部品タグ 0x38〜 で、ffmpeg が
     * 出しているのは字幕 (0x30〜) のほう
     */
    test('文字スーパーは読まない', () => {
        const clock = started();
        clock.feed(pesPacket(SUPER_PID, 12345));
        expect(clock.latest).toBeNull();
    });

    /** 映像にも時刻は乗っているが、こちらが要るのは字幕のぶん */
    test('映像は読まない', () => {
        const clock = started();
        clock.feed(pesPacket(VIDEO_PID, 12345));
        expect(clock.latest).toBeNull();
    });

    /** PMT を読むまでは、どの PID が字幕かも分からない */
    test('PMT が来る前は読めない', () => {
        const clock = new CaptionClock();
        clock.feed(pesPacket(CAPTION_PID, 12345));
        expect(clock.latest).toBeNull();
    });
});

/**
 * **90kHz は 26.5時間で一周する。** 長く見ていれば跨ぐので、そのとき
 * 何時間も飛んだことにしない
 */
describe('since', () => {
    test('ふつうの引き算', () => {
        expect(since(90000 * 10, 90000 * 4)).toBe(90000 * 6);
    });

    test('一周を跨いでも近いほうを採る', () => {
        // 原点は一周の直前、字幕は回った先。差は 1秒
        expect(since(90000 - 1, WRAP - 1)).toBe(90000);
    });

    /** 原点より前の字幕 (選局した瞬間に掛かったもの) は負になる */
    test('原点より前なら負', () => {
        expect(since(90000 * 3, 90000 * 5)).toBe(-90000 * 2);
    });
});
