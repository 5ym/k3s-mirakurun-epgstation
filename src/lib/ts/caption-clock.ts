/**
 * **字幕がいつ出るものかを、電波から読む。**
 *
 * 字幕の PES には「出すべき放送時刻」(PTS) が乗っている。ffmpeg が絵に付ける
 * 時刻もこれと同じで、実機で数えると **64件中64件が ±1ms 以内**で一致した。
 * だから電波を読んでおけば、絵が出てきたときに「その絵をいつ出すか」が分かる。
 *
 * **絵と行を数で組にしない。** 以前 `showinfo` に喋らせていた頃は、
 * 出てきた PNG 77枚に対して行が 79本あり、余ったぶんだけ以降ずっと1つずれた
 * (`server/captions.ts`)。ここは**いちばん最近届いたもの**を返すだけにする —
 * 絵は届いた端から出てくるので (実機で -15ms、103本中102本で一致)、
 * 字幕どうしの間隔 (実機で最短 133ms) より十分に速い。
 */

import { descriptors, PACKET, PacketStream, SectionAssembler, SYNC } from './psi';

/** ARIB の部品タグ。字幕は 0x30〜0x37、文字スーパーは 0x38〜 */
const COMPONENT_TAG = 0x52;
const CAPTION_TAG_FIRST = 0x30;
const CAPTION_TAG_LAST = 0x37;
/** 字幕もデータ放送も、PMT ではこれ (ITU-T H.222.0 の private PES) */
const STREAM_TYPE_PRIVATE = 0x06;

/**
 * 1局ぶんの TS を食わせると、**直近の字幕の時刻** (90kHz) を返す。
 *
 * **渡すのは1局に絞ったあとの TS** (`ServiceFilter` を通したもの)。丸ごとだと
 * 別の局の PMT を拾ってしまう。
 */
export class CaptionClock {
    private readonly packets = new PacketStream();
    private readonly pat = new SectionAssembler(0);
    private pmt: SectionAssembler | null = null;
    /** 字幕の PID。**PMT の並びで最初の1本**だけ見る (ffmpeg の `s:0` と同じ) */
    private captionPid = -1;
    private seen: number | null = null;

    /** 直近に届いた字幕の時刻 (90kHz)。**まだ1本も来ていなければ null** */
    get latest(): number | null {
        return this.seen;
    }

    /** 1局に絞った TS を食わせる */
    feed(chunk: Uint8Array): void {
        for (const packet of this.packets.feed(chunk)) this.packet(packet);
    }

    private packet(packet: Uint8Array): void {
        if (packet[0] !== SYNC) return;
        const pid = ((packet[1] & 0x1f) << 8) | packet[2];

        if (pid === 0) {
            for (const section of this.pat.feed(packet)) this.readPat(section);
            return;
        }
        if (this.pmt !== null && this.captionPid < 0) {
            for (const section of this.pmt.feed(packet)) this.readPmt(section);
        }
        if (pid !== this.captionPid) return;

        const adaptation = (packet[3] >> 4) & 0x03;
        if (adaptation === 0 || adaptation === 2) return;
        let at = 4;
        if (adaptation === 3) at += 1 + packet[4];
        if (at >= PACKET) return;
        // PES の頭にだけ時刻が乗る
        if ((packet[1] & 0x40) === 0) return;
        const pes = packet.subarray(at);
        if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return;
        if ((pes[7] & 0x80) === 0) return;
        this.seen =
            (pes[9] & 0x0e) * 536870912 +
            pes[10] * 4194304 +
            ((pes[11] & 0xfe) >> 1) * 32768 +
            pes[12] * 128 +
            ((pes[13] & 0xfe) >> 1);
    }

    private readPat(section: Uint8Array): void {
        // 1局に絞ってあるので、載っているのは1つだけ
        for (let at = 8; at + 4 <= section.length - 4; at += 4) {
            const program = (section[at] << 8) | section[at + 1];
            if (program === 0) continue;
            const pid = ((section[at + 2] & 0x1f) << 8) | section[at + 3];
            if (this.pmt === null) this.pmt = new SectionAssembler(pid);
            return;
        }
    }

    private readPmt(section: Uint8Array): void {
        const infoLength = ((section[10] & 0x0f) << 8) | section[11];
        let at = 12 + infoLength;
        const end = section.length - 4;
        while (at + 5 <= end) {
            const type = section[at];
            const pid = ((section[at + 1] & 0x1f) << 8) | section[at + 2];
            const length = ((section[at + 3] & 0x0f) << 8) | section[at + 4];
            if (type === STREAM_TYPE_PRIVATE && this.captionPid < 0) {
                for (const [tag, body] of descriptors(section.subarray(at + 5, at + 5 + length))) {
                    // **文字スーパー (0x38〜) は採らない。** あちらは別の口で流れてくる
                    if (
                        tag === COMPONENT_TAG &&
                        body[0] >= CAPTION_TAG_FIRST &&
                        body[0] <= CAPTION_TAG_LAST
                    ) {
                        this.captionPid = pid;
                    }
                }
            }
            at += 5 + length;
        }
    }
}

/** 90kHz の一周 (2^33)。PCR も PTS もここで戻る */
export const WRAP = 8589934592;

/**
 * 放送時刻の引き算。**一周 (2^33) を跨いでも近いほうを採る。**
 *
 * 90kHz は 26.5時間で一周するので、長く見ていると跨ぐ
 */
export function since(pts: number, origin: number): number {
    let gap = pts - origin;
    if (gap < -WRAP / 2) gap += WRAP;
    if (gap > WRAP / 2) gap -= WRAP;
    return gap;
}
