import { describe, expect, test } from 'bun:test';
import { type AudioSide, audioTracks } from '$lib/arib';
import { captionLead, codecsFor, encodeArgs } from './live';

/** 1本目の音声をそのまま。番組表が何も言っていないときの既定 */
const stereo = audioTracks([])[0];
/** デュアルモノの中から選ぶ。0=主音声 1=副音声 2=主+副 */
const dual = (side: AudioSide) => {
    const tracks = audioTracks([{ componentType: 2, langs: ['jpn', 'eng'] }]);
    const found = tracks.find((track) => track.side === side);
    if (found === undefined) throw new Error(`デュアルモノに ${side} が無い`);
    return found;
};

/** 実写・ステレオ・NHK総合1 (T27 に2局乗っている) */
const plain = () => encodeArgs(1024, true, stereo);

/**
 * **焼き方の指定は、間違えても絵は出る。** 出たうえで見づらいだけなので、
 * 気付くのに時間がかかる。実機で測って分かったものをここで固定する。
 */
describe('ライブの焼き方', () => {
    /*
     * **`-flags low_delay` を入れない。**
     *
     * `-i` より前に書くとエンコーダではなくデコーダに効く。放送の MPEG-2 には
     * B フレームがあるので、この指定を受けたデコーダは表示順ではなく復号順で
     * 絵を出し、1枚進んでは戻るように見える。実測で隣り合うコマの差の比が
     * 2.17 → 1.11 に落ちた (素材のフィールドを直に測ると 1.02)。
     * エンコーダ側の遅れは `-tune zerolatency` が見ている。
     */
    test('デコーダに低遅延を指図しない', () => {
        expect(plain()).not.toContain('low_delay');
    });

    /*
     * **入口の解析は小さくてよい。渡す前に1局へ絞るから。**
     *
     * ffmpeg は名指しした局を `-probesize` のぶん読む間に見つけられなければ、
     * **そのまま終了する**。実機の tvk (T15。tvk1/2/3 + ワンセグ + データで、
     * 局ごとに14本以上のストリーム) では 400KB でも足りず、
     * `Failed to set value '0:p:24632:v:0' for option 'map'` で降りていた。
     *
     * わざと probesize を下げて T15 で測ったもの (3回ずつ):
     *
     *     20KB   丸ごと 0/3 通る   1局に絞る 3/3
     *     50KB   丸ごと 0/3 通る   1局に絞る 3/3
     *    120KB   丸ごと 1/3 通る   1局に絞る 3/3
     *
     * 絞れば 20KB でも通る。**そこまで下げてある** — 6回ずつ測ると
     * 100KB は最短 474ms、20KB は最短 441ms で、33ms は固定の費用
     */
    test('入口の解析は 20KB まで', () => {
        const args = plain();
        expect(args[args.indexOf('-probesize') + 1]).toBe('20000');
    });

    /*
     * **コマごとに切らない。** `frag_every_frame` だと映像だけ・音声だけの塊が
     * 交互に並び (トラックごとにコマの間隔が違うため)、受け側の MSE が
     * それぞれを別の区切りとして扱って映像と音声を別々に並べ直す。
     * 実機では毎秒95個出ていた。
     *
     * **細かさの下限は音声のコマが決める。** AAC は 1024 標本 = 約 21ms なので、
     * それより短く切ると音声の入らない塊が出る (実機で 16ms にすると
     * 塊あたりのトラック数が 1.94 → 1.74 に落ちた)
     */
    test('音声のコマより短く区切らない', () => {
        const args = plain();
        expect(args.join(' ')).not.toContain('frag_every_frame');
        const µs = Number(args[args.indexOf('-frag_duration') + 1]);
        expect(µs).toBeGreaterThanOrEqual(25_000);
        expect(µs).toBeLessThanOrEqual(200_000);
    });

    /*
     * **インタレ解除は録画と同じ判断で行う。** 放送は 1080i なので、解かずに
     * 渡すと動きのある場面が櫛状になる。国内アニメだけコマ数を倍にしない
     */
    test('インタレを解く。国内アニメだけコマ数を倍にしない', () => {
        const live = encodeArgs(1024, true, stereo);
        const anime = encodeArgs(1024, false, stereo);
        expect(live[live.indexOf('-vf') + 1]).toBe('bwdif');
        expect(anime[anime.indexOf('-vf') + 1]).toBe('bwdif=mode=send_frame');
    });

    /*
     * **局を名指しで選ぶ。** 1本の物理チャンネルに複数の局が乗っているので、
     * `0:v:0` は「最初に見つけた映像」でしかない。実機の T26 には Eテレ1/2/3 と
     * **ワンセグ** (320x180 の H.264) が並んでいて、それを掴む目まである
     */
    test('選んだ局の中から映像と音声を採る', () => {
        const args = encodeArgs(1032, true, stereo);
        expect(args).toContain('0:p:1032:v:0');
        expect(args).toContain('0:p:1032:a:0');
    });

    /** 局が分からないときは従来どおり。**絵が出ないより、先頭の局のほうがまし** */
    test('局が分からなければ最初に見つけた映像を採る', () => {
        const args = encodeArgs(0, true, stereo);
        expect(args).toContain('0:v:0');
        expect(args).toContain('0:a:0');
    });

    /*
     * **二カ国語は左右に別の言語。** そのままステレオにすると両方同時に鳴る。
     * 録画は左右を2トラックに分けるが、こちらは器が1つなので選ばれた側を両耳へ。
     *
     * 右 (`c1`) を左右に配るのが副音声。**左右を取り違えると、選んだのと逆の
     * 言語が鳴る** — 絵は出るので、気付くのは音を聞いたときだけ
     */
    test('二カ国語は選ばれた側だけを両耳へ', () => {
        const main = encodeArgs(1024, true, dual('main'));
        const sub = encodeArgs(1024, true, dual('sub'));
        expect(main[main.indexOf('-af') + 1]).toBe('pan=stereo|c0=c0|c1=c0');
        expect(sub[sub.indexOf('-af') + 1]).toBe('pan=stereo|c0=c1|c1=c1');
    });

    /** 「主+副」はテレビと同じで、左右から別の言語が同時に鳴る状態 */
    test('主+副はそのまま出す', () => {
        expect(encodeArgs(1024, true, dual('both'))).not.toContain('-af');
    });

    test('普通のステレオでは音をいじらない', () => {
        expect(plain()).not.toContain('-af');
    });

    /*
     * **音声が2本以上入っている放送では、0 が選ばれるとは限らない。**
     * 解説放送などは音声そのものが別に乗っているので、何本目かを名指しする
     */
    test('2本目の音声を選べる', () => {
        const tracks = audioTracks([
            { componentType: 3, langs: ['jpn'] },
            { componentType: 3, langs: ['eng'] },
        ]);
        const args = encodeArgs(1032, true, tracks[1]);
        expect(args).toContain('0:p:1032:a:1');
        expect(args).not.toContain('0:p:1032:a:0');
    });

    /** 受け側は使わないが、サーバ側で字幕と突き合わせて測るのに要る (`captionLead`) */
    test('元TSの時刻を保つ', () => {
        expect(plain()).toContain('-copyts');
    });

    /*
     * **字幕と時刻を突き合わせないので、コマごとに喋らせるものが無い。**
     *
     * 絶対の時刻で合わせる道は2回外している (`live.ts` の説明)。いまは時刻では
     * なく**待たせる量**を渡すので、コマごとに添えるものは何も無い。
     * `showinfo` を挟んでいた頃は**毎秒60行**が標準エラーに流れていた
     */
    test('コマごとに showinfo を吐かせない', () => {
        expect(plain()[plain().indexOf('-vf') + 1]).not.toContain('showinfo');
    });

    /*
     * **失敗だけ残す。** `showinfo` を外したので絞れる。字幕側は絞れない
     * (あちらは `showinfo` が info で喋る。`captions.ts`)
     */
    test('記録は失敗だけに絞る', () => {
        const args = plain();
        expect(args[args.indexOf('-loglevel') + 1]).toBe('error');
    });
});

/**
 * **焼き方は見ながら選べる** (`LiveCodec`)。絵の中身ではなく「その端末で出るか」
 * の話なので、音声とは別に選ばせる。
 *
 * AV1 は設計 (stream.md §1) が最初から狙っていた形。実機は HW エンコーダを
 * 持たないが 44 スレッドあり、同じ電波を 40 秒ずつ通した実測では落ちこぼれない:
 *
 *     x264 veryfast   1バイト目 729ms   焼けた尺 38.5秒/41秒
 *     AV1 preset 12   1バイト目 1177ms  焼けた尺 39.1秒/41秒
 *
 * **量は中身次第。** どちらも品質を指定して焼いているので、ある40秒では
 * AV1 が 15% 小さく (3.3 → 2.8 Mbit/s)、別の25秒ではほぼ同じ (11.6 → 11.4) だった
 */
describe('焼き方を選ぶ', () => {
    const av1 = () => encodeArgs(1024, true, stereo, 'av1');

    test('既定は H.264。**どの端末でも出る**', () => {
        expect(plain()).toContain('libx264');
        expect(encodeArgs(1024, true, stereo, 'h264')).toContain('libx264');
    });

    test('AV1 を選ぶと SVT-AV1 で焼く', () => {
        expect(av1()).toContain('libsvtav1');
        expect(av1()).not.toContain('libx264');
    });

    /*
     * **先読みを切る。** SVT-AV1 は既定で先を読むぶん貯めるので、付けないと
     * その貯めがそのまま遅れになる。ライブは待たせないほうが優先
     */
    test('AV1 に先を読ませない', () => {
        expect(av1().join(' ')).toContain('lookahead=0');
    });

    /*
     * **鍵フレームの間隔は揃える。** 途中から入ってきた人が待つ長さはここで
     * 決まるので、形を選び直したら待ちが変わる、では困る
     */
    test('鍵フレームの間隔は形を変えても同じ', () => {
        const gap = (args: string[]) => args[args.indexOf('-g') + 1];
        expect(gap(av1())).toBe(gap(plain()));
    });

    /*
     * **MSE はこれが合っていないと受け取らない。** Chromium で実際に聞くと
     * `avc1.640029` も `av01.0.08M.08` も通り、`mp2v.61` (放送そのまま) は通らない
     */
    test('ブラウザに渡す名前は形ごとに変わる', () => {
        expect(codecsFor('h264')).toContain('avc1.');
        expect(codecsFor('av1')).toContain('av01.');
    });
});

/**
 * **AV1 と組むときは Opus。**
 *
 * 設計 (stream.md §1) が狙っていた組み合わせで、録画と同じ扱いでもある
 * (`encoder.ts` は前から `libopus -b:a 256k`)。ライブだけ 192k AAC で
 * 低かったのを、放送 (AAC 256kbps) に合わせた 256k へ寄せる。
 *
 * H.264 は AAC のまま。**どの端末でも出る**ほうを既定にしている以上、
 * 音声まで替える理由が無い。
 */
describe('音声も組で決まる', () => {
    const args = (codec: 'h264' | 'av1') => encodeArgs(1024, true, stereo, codec);
    const rate = (a: string[]) => a[a.indexOf('-b:a') + 1];

    test('AV1 は Opus 256k', () => {
        expect(args('av1')).toContain('libopus');
        expect(rate(args('av1'))).toBe('256k');
        expect(codecsFor('av1')).toContain('opus');
    });

    test('H.264 は AAC のまま', () => {
        expect(args('h264')).toContain('aac');
        expect(args('h264')).not.toContain('libopus');
        expect(codecsFor('h264')).toContain('mp4a.40.2');
    });

    /** デュアルモノの配り直しは音声の形より手前。どちらを選んでも効く */
    test('左右の配り直しは形によらず効く', () => {
        const sub = audioTracks([{ componentType: 2, langs: ['jpn', 'eng'] }])[1];
        for (const codec of ['h264', 'av1'] as const) {
            const out = encodeArgs(1024, true, sub, codec);
            expect(out[out.indexOf('-af') + 1]).toContain('c0=c1');
        }
    });

    /** どちらも 2ch に落とす。器が1つなので、5.1ch をそのまま渡せない */
    test('どちらも2chに落とす', () => {
        for (const codec of ['h264', 'av1'] as const) {
            const out = args(codec);
            expect(out[out.indexOf('-ac') + 1]).toBe('2');
        }
    });
});

/**
 * **H.264 は量を捨てて速さを採る。** AV1 と役割が分かれている —
 * あちらが「小さく」、こちらが「速く」。
 *
 * 実機で6回ずつ測ったもの。ばらつきは放送の GOP 待ち (0〜501ms) なので、
 * 短いほうの2つを見る:
 *
 *     veryfast  既定      最短 438ms  2番目 535ms   2.5 Mbit/s  ← 前
 *     ultrafast 既定      最短 386ms  2番目 429ms   8.2 Mbit/s  ← これ
 *     ultrafast crf 20    最短 524ms  2番目 584ms  10.7 Mbit/s
 *     ultrafast crf 18    最短 478ms  2番目 511ms  14.6 Mbit/s
 *     ultrafast crf 14    最短 586ms              35.9 Mbit/s
 *     ultrafast 無劣化    最短 643ms             235.7 Mbit/s
 */
describe('H.264 は速さを優先する', () => {
    test('いちばん速い設定で焼く', () => {
        expect(plain()[plain().indexOf('-preset') + 1]).toBe('ultrafast');
    });

    /*
     * **画質は据え置き。** 上げると必ず遅くなる (最初の1枚が太り、書き出すのに
     * 時間がかかる)。速さが目的なので、ここは触らない — 出てくる絵は今までと
     * 同じで、増えるのは量だけ
     */
    test('画質は指定しない (上げると遅くなる)', () => {
        expect(plain()).not.toContain('-crf');
        expect(plain()).not.toContain('-qp');
    });

    /** AV1 は量のほう。こちらの設定を持ち込まない */
    test('AV1 には持ち込まない', () => {
        const av1 = encodeArgs(1024, true, stereo, 'av1');
        expect(av1).not.toContain('ultrafast');
        expect(av1).toContain('libsvtav1');
    });
});

/**
 * **コマ数の上限を言っておく。**
 *
 * `-probesize` を 20KB まで削ったので、ffmpeg は入口でコマ数を読み切れず、
 * 時間の刻み (90kHz) からでたらめな値を起こすことがある。x264 は黙って受けるが、
 * **SVT-AV1 は突っぱねる** (`The maximum allowed frame rate is 240 fps`)。
 * 実機で 20KB のまま AV1 を選ぶと 0/3、上限を付けると 3/3 通った。
 */
describe('コマ数の上限', () => {
    const cap = (args: string[]) => args[args.indexOf('-fpsmax') + 1];

    test('インタレ解除の出方に合わせる', () => {
        // フィールドを起こす = 59.94
        expect(cap(encodeArgs(1024, true, stereo))).toBe('60000/1001');
        // フレームのまま = 29.97 (国内アニメ)
        expect(cap(encodeArgs(1024, false, stereo))).toBe('30000/1001');
    });

    /*
     * **固定 (`-r`) ではなく上限。** 固定すると、放送が本当に 59.94p だったとき
     * (720p の局) にコマを落とす
     */
    test('固定はしない', () => {
        expect(encodeArgs(1024, true, stereo)).not.toContain('-r');
    });

    /** どちらの焼き方でも要る。読み切れないのは入口の話 */
    test('どちらの焼き方でも付ける', () => {
        for (const codec of ['h264', 'av1'] as const) {
            expect(encodeArgs(1024, true, stereo, codec)).toContain('-fpsmax');
        }
    });
});

/**
 * **字幕を待たせる量。** 字幕は映像より先に出てくるので、そのぶん待たせる
 * (`captionLead` に実測の内訳)。
 */
describe('字幕を待たせる量', () => {
    /**
     * **H.264 は待たせない。** 字幕が届いたときには、その字幕が属する映像も
     * もう届いている (実機で 0 / 0.2 / 0.45秒 を出し比べて 0 がいちばん合った)
     */
    test('H.264 は待たせない', () => {
        expect(captionLead('h264', true)).toBe(0);
        expect(captionLead('h264', false)).toBe(0);
    });

    /** **局では変わらない。** 電波の中の先回りは字幕にも映像にも掛かって相殺する */
    test('局では変わらない', () => {
        expect(captionLead('h264', true)).toBe(captionLead('h264', false));
        expect(captionLead('av1', true)).toBe(captionLead('av1', true));
    });

    /**
     * **AV1 だけ待たせる。** SVT-AV1 が溜め込むぶん映像だけが遅れて届く。
     * 溜める量は枚数で決まるので、コマ数を倍にすると待ちは縮む
     */
    test('AV1 は待たせる。コマ数が多いほど短い', () => {
        expect(captionLead('av1', false)).toBeGreaterThan(captionLead('h264', false));
        expect(captionLead('av1', true)).toBeLessThan(captionLead('av1', false));
    });
});
