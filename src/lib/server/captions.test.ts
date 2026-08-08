import { describe, expect, test } from 'bun:test';
import { CHANNEL } from '$lib/live';
import { CANVAS, captionArgs, frame, PngSplitter, TrackList } from './captions';

/**
 * PNG 1枚ぶん。**かたまりの形まで真似る** — 切れ目を `IEND` で見つけるので、
 * 署名だけの偽物では確かめられない。
 *
 *     [8バイトの署名][4:長さ][4:種別][中身][4:CRC] … [0][IEND][CRC]
 */
const png = (fill: number, body = 8) => {
    const out = new Uint8Array(8 + 12 + body + 12);
    out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(out.buffer);
    // IDAT のつもりのかたまり1つ
    view.setUint32(8, body);
    out.set([0x49, 0x44, 0x41, 0x54], 12);
    out.fill(fill, 16, 16 + body);
    // IEND
    view.setUint32(8 + 12 + body, 0);
    out.set([0x49, 0x45, 0x4e, 0x44], 8 + 12 + body + 4);
    return out;
};

describe('字幕の取り出し方', () => {
    /*
     * **`-copyts` が要る。** 付けないと ffmpeg は字幕1枚目を 0 秒として数え直す
     * (フィルタに入れるのが字幕1本だけで、基準になる映像がこちら側に無いため)。
     * 映像側も同じにしてあるので、受け側は届いた時刻と再生位置を直に比べられる
     */
    test('元TSの時刻をそのまま持つ', () => {
        expect(captionArgs(1024)).toContain('-copyts');
    });

    /*
     * **`-canvas_size` が要る。** 無いと libaribcaption は 1440x1080 (PROFILE_A)
     * とみなすので、1920x1080 の放送では字幕だけ横に伸びる
     */
    test('画面の大きさを渡す', () => {
        const args = captionArgs(1024);
        expect(args[args.indexOf('-canvas_size') + 1]).toBe(`${CANVAS.width}x${CANVAS.height}`);
    });

    /*
     * **PNG まで ffmpeg に組ませる。** 実機で同じ TS 30秒ぶんを通した実測:
     * 生の RGBA 1.94秒 (406MB) / PNG 1.05秒 (1.76MB) / 256色 PNG 4.30秒 (0.94MB)。
     * 生のほうが遅いのは書く量が桁違いだから。denpa 側の切り抜き・色数落とし・
     * PNG 組み立ては、まるごと要らない
     */
    test('絵は PNG で受け取る', () => {
        const args = captionArgs(1024);
        expect(args).toContain('image2pipe');
        expect(args[args.indexOf('-c:v') + 1]).toBe('png');
        expect(args).not.toContain('rawvideo');
    });

    /** 局を名指しする。1本の物理チャンネルに複数の局が乗っている (映像と同じ) */
    test('選んだ局の字幕を採る', () => {
        expect(captionArgs(1032).join(' ')).toContain('[0:p:1032:s:0]null');
    });

    test('局が分からなければ最初に見つけた字幕', () => {
        expect(captionArgs(0).join(' ')).toContain('[0:s:0]null');
    });

    /** 出てきた枚をそのまま出す。詰め直させると時刻がずれる */
    test('コマ数を揃え直させない', () => {
        const args = captionArgs(1024);
        expect(args[args.indexOf('-fps_mode') + 1]).toBe('passthrough');
    });

    /*
     * **showinfo には喋らせない。**
     *
     * 時刻と「空かどうか」を標準エラーに喋らせて、標準出力の PNG と来た順に
     * 組にしていた。**数が合わない** — 実機の日テレで70秒測ると PNG 77枚に対し
     * showinfo 79行で、余ったぶんだけ以降ずっと1つずれる。ずれると字幕の出た枚に
     * 1つ前の「空」が当たって「消す」に化け、**字幕が遅れて出て、消えるのも
     * 遅れる**。いまは絵だけを見るので、組にするものが無い
     */
    test('別の口に喋らせない', () => {
        expect(captionArgs(1024)).not.toContain('showinfo');
    });
});

/**
 * PNG は `IEND` で切る。
 *
 * **次の署名を待ってはいけない。** 待っていた頃は1枚が次の1枚に足止めされ、
 * 字幕が次に変わるまで前の字幕が出なかった — 間隔の空く番組ほど遅れる
 * (実機で「字幕が遅い」として出た)。
 */
describe('PngSplitter', () => {
    /** ここが遅れの分かれ目。**1枚届いたら、その場で出す** */
    test('1枚そろったら、次を待たずに出す', () => {
        const splitter = new PngSplitter();
        const a = png(0x11);
        const out = splitter.feed(a);
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual(a);
    });

    test('続けて来たぶんも順に出す', () => {
        const splitter = new PngSplitter();
        const a = png(0x11);
        const b = png(0x22);
        const joined = new Uint8Array(a.length + b.length);
        joined.set(a);
        joined.set(b, a.length);
        const out = splitter.feed(joined);
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual(a);
        expect(out[1]).toEqual(b);
    });

    /** パイプなので、かたまりの切れ目で届くとは限らない */
    test('途中で切れて届いても組み直す', () => {
        const splitter = new PngSplitter();
        const a = png(0x11, 40);
        expect(splitter.feed(a.subarray(0, 5))).toHaveLength(0);
        expect(splitter.feed(a.subarray(5, 30))).toHaveLength(0);
        const out = splitter.feed(a.subarray(30));
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual(a);
    });

    test('署名の前に来たごみは捨てる', () => {
        const splitter = new PngSplitter();
        const a = png(0x11);
        const junk = new Uint8Array([1, 2, 3]);
        const joined = new Uint8Array(junk.length + a.length);
        joined.set(junk);
        joined.set(a, junk.length);
        const out = splitter.feed(joined);
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual(a);
    });
});

/**
 * **放送が字幕を持っているかは、1枚も来ていなくても分かる。**
 *
 * ffmpeg が入口で読んだストリーム一覧に出ている。届いてから画面に切り替えを
 * 出していた頃は、間隔の空く番組を開くとボタンが出なかった (実機の
 * 「みんなの手話」。番組表には [字] と出ているのに)。
 */
describe('TrackList', () => {
    /** 実機の T26 (Eテレ) がそのまま出したもの */
    const etv = [
        '  Program 1032 ',
        '  Stream #0:0[0x100]: Video: mpeg2video (Main), 1440x1080, 29.97 fps',
        '  Stream #0:1[0x110]: Audio: aac (LC), 48000 Hz, stereo',
        '  Stream #0:2[0x130]: Subtitle: arib_caption (libaribcaption) (Profile A), 1920x1080',
        '  Stream #0:3[0x138]: Data: bin_data',
        '  Program 1033 ',
        '  Stream #0:4[0x101]: Video: mpeg2video (Main), 1440x1080, 29.97 fps',
        '  Stream #0:5[0x131]: Subtitle: arib_caption (libaribcaption) (Profile A), 1920x1080',
    ];

    test('選んだ局の字幕だけ数える', () => {
        const list = new TrackList(1032);
        for (const line of etv) list.feed(line);
        expect(list.tracks).toHaveLength(1);
        expect(list.tracks[0]).toMatchObject({ index: 0, label: '字幕' });
    });

    /** ほかの局の字幕を数えると、選べないものが一覧に並ぶ */
    test('別の局の字幕は数えない', () => {
        const list = new TrackList(1033);
        for (const line of etv) list.feed(line);
        expect(list.tracks).toHaveLength(1);
    });

    /** **言語が複数ある放送はたまにある。** そのときは2本以上になる */
    test('言語が複数あれば、その数だけ出す', () => {
        const list = new TrackList(1024);
        for (const line of [
            '  Program 1024 ',
            '  Stream #0:1[0x110](jpn): Audio: aac (LC), 48000 Hz, stereo',
            '  Stream #0:2[0x130](jpn): Subtitle: arib_caption (Profile A), 1920x1080',
            '  Stream #0:3[0x131](eng): Subtitle: arib_caption (Profile A), 1920x1080',
        ]) {
            list.feed(line);
        }
        expect(list.tracks.map((t) => t.label)).toEqual(['字幕 (日本語)', '字幕2 (英語)']);
        expect(list.tracks.map((t) => t.index)).toEqual([0, 1]);
    });

    test('字幕を持たない局では空', () => {
        const list = new TrackList(1416);
        for (const line of etv) list.feed(line);
        expect(list.tracks).toHaveLength(0);
    });

    /** 増えたときだけ true。毎行で知らせると画面が無駄に描き直される */
    test('増えたときだけ知らせる', () => {
        const list = new TrackList(1032);
        expect(list.feed('  Program 1032 ')).toBe(false);
        expect(list.feed('  Stream #0:0[0x100]: Video: mpeg2video (Main)')).toBe(false);
        expect(list.feed('  Stream #0:2[0x130]: Subtitle: arib_caption (Profile A)')).toBe(true);
    });
});

/**
 * 送る形。頭に置き場所を付ける (stream.md §5.3)。いまは画面まるごとを送るので
 * x,y は 0 だが、**あとで切り抜くようにしても受け側を変えずに済む**。
 */
describe('frame', () => {
    test('絵は種別 0x20 で、頭に置き場所が付く', () => {
        const data = png(0x11);
        const out = frame({ data });
        expect(out.kind).toBe(CHANNEL.subtitle);
        const view = new DataView(out.data.buffer, out.data.byteOffset);
        expect([view.getUint16(0), view.getUint16(2), view.getUint16(4), view.getUint16(6)]).toEqual([
            0,
            0,
            CANVAS.width,
            CANVAS.height,
        ]);
        expect(out.data.subarray(8)).toEqual(data);
    });

    /*
     * **いつ出すかは添えない。** 絶対の時刻で合わせる道は2回外している —
     * mp4 の 0 は多重化器の都合で決まる (probe の間に溜まった音声に合う。実機で
     * 2.4秒ずれた) し、「焼いている絵より何秒前か」を送る道もフィルタが符号器より
     * 先を走るぶんずれた (実機で5秒)。受け側は**いちばん新しく届いている映像から、
     * 決まった量だけ待たせて**出す (`live.ts` の `captionLead`)。
     *
     * 放送の時刻を添えるのもやめた。読むには `showinfo` を別の口で喋らせる
     * ことになり、**その行と絵の数が合わずに字幕が遅れていた** (captions.ts)
     */
    test('いつ出すかは添えない', () => {
        expect(frame({ data: png(0x11) }).pts).toBe(0n);
        expect(frame({ data: png(0x11) }).data.length).toBe(8 + png(0x11).length);
    });
});
