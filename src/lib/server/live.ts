/**
 * ライブ視聴。**チューナーを開いて、焼いて、繋いでいる人に配る。**
 *
 *     エージェント (MPEG-TS) → ffmpeg (fMP4) → 割る → WebSocket → MSE
 *
 * [stream.md](../../../docs/stream.md) §4 の1番目にあたる。**字幕は同じ
 * WebSocket に相乗りする** (`captions.ts`)。あちらは局までで決まるので、
 * 焼き方 (コマ数・音声) では分けない。データ放送 (§5.5) はまだ。
 *
 * ## 同じチャンネルは1本で焼く
 *
 * 2人が同じチャンネルを見ても、チューナーも ffmpeg も1つで足りる。
 * **数えているのは見ている人の数**で、0になったら畳む。エージェント側でも
 * 同じチャンネルは相乗りになるが、こちらで畳まないと ffmpeg が residual に残る。
 *
 * ## 途中から入ってきた人
 *
 * MSE は init セグメントを先に受け取らないと**中身を1バイトも読まない**ので、
 * 最後に流した init を持っておいて、繋いできた人に真っ先に渡す。
 */

import { type Audio, type AudioTrack, audioTracks, pickTrack } from '$lib/arib';
import { CHANNEL, type LiveCodec, type Notice } from '$lib/live';
import { Fmp4Splitter } from '$lib/ts/fmp4';
import { ServiceFilter } from '$lib/ts/service-filter';
import { frame, TROUBLE, watchCaptions } from './captions';
import { config } from './config';
import { queryOne } from './db';
import { deinterlace, smoothMotionFor } from './encoder';
import { chunks, lines } from './stream';
import { openWhenFree } from './tuner';
import type { Connection } from './ws';

/**
 * 焼き方。**形は見ている人が選ぶ** (`LiveCodec`)。
 *
 * H.264 と AV1 で共通なのはここ。それぞれの中身は `videoArgs` / `audioArgs`。
 *
 * - `-fflags nobuffer` … 読む側で溜めない
 * - `-probesize` … **開いてから絵が出るまでの待ちの、削れる部分。**
 *   渡す前に1局へ絞ってあるので 20KB で足りる (下の「渡す前に1局へ絞る」に実測)
 * - `-frag_duration` … 0.05秒ぶんずつ moof/mdat を出す。既定では ffmpeg が
 *   数秒溜めてから出すので、その場でライブでなくなる
 * - `-copyts` … 元TSの時刻を保つ。**受け側は使わない** (mp4 は 0 から始まるので
 *   物差しが違う) が、外すと**サーバ側で映像と字幕を突き合わせて測れなくなる** —
 *   `captionLead` の値はこれがあるから測れた
 *
 * ## コマごとに切らない
 *
 * `frag_every_frame` にすると、**映像だけ・音声だけの塊が交互に並ぶ**。
 * mp4 の多重化はトラックごとにコマの来る間隔が違うためで、受け側の MSE は
 * その1つ1つを別の区切りとして扱う。結果、映像と音声が別々に並べ直されて、
 * 絵は絶えず引っかかり、音はずれる。時間で切れば1つの塊に両方入る。
 *
 * **どこまで細かくできるかは音声のコマが決める。** AAC は 1024 標本 = 48kHz で
 * 約 21ms、Opus は 20ms なので、どちらでも同じところに下限がある。それより
 * 短く切ると音声の入らない塊が出る。実機で数えた
 * 「塊あたりのトラック数」(2.00 が両方入っている状態):
 *
 *     0.20秒 → 毎秒 6個  1.93      0.05秒 → 毎秒 21個  1.94
 *     0.10秒 → 毎秒 11個 1.93      0.033秒→ 毎秒 32個  1.94
 *                                  0.016秒→ 毎秒 64個  1.74 ← 崩れる
 *
 * 0.05秒を採る。0.033秒でも保つが、音声のコマ (21ms) に近すぎる。
 *
 * ## `-flags low_delay` は付けない
 *
 * `-i` より前に書くと**エンコーダではなくデコーダに効く**。放送の MPEG-2 には
 * B フレームがあるので、この指定を受けたデコーダは表示順ではなく**復号順**で
 * 絵を出す。結果、1枚進んでは戻るように見える。
 *
 * 実測 (NHK総合の高校野球・本物の 60i): 隣り合うコマの差が交互に大小し、
 * その比は 2.17。外すと 1.11 に落ち、元の素材のフィールドを直に測った
 * 値 (1.02) に並ぶ。エンコーダ側の遅れは `-tune zerolatency` が見ている。
 *
 * **インタレ解除は録画と同じ判断で行う** (`encoder.deinterlace`)。放送は 1080i
 * なので、解かずにブラウザへ渡すと動きのある場面が櫛状になる。国内アニメだけ
 * コマ数を倍にしないのも録画と揃える — 元が毎秒24コマ前後なので、倍にしても
 * 同じ絵が並ぶだけで、CPU だけ倍かかる。
 *
 * ## 字幕とは時刻を突き合わせない。**待たせる量だけ渡す**
 *
 * **絶対の時刻では合わせられない。** `-copyts` で放送の時刻を保っているのは
 * ffmpeg の中までで、mp4 の多重化器は最初のパケットを 0 に詰め直す
 * (`-avoid_negative_ts disabled` も `-muxdelay 0` も `-output_ts_offset` も
 * 効かない。実機で確認)。しかもその「最初のパケット」は**音声**のことが多い —
 * 焼かれた1コマ目の放送時刻を引く手を採ったときは、実機で 2.4 秒ずれた。
 * 「いま焼いている絵より何秒前か」を添える手も、フィルタが符号器より先を走る
 * ぶん 5 秒ずれた。**どちらもこちらの都合で動く量**だった。
 *
 * 添えるのは時刻ではなく、**どれだけ待たせるか**にした (`captionLead`)。
 * 受け側はそれを、いま映っている絵に足して置く。
 *
 * そのため `showinfo` は要らない — コマごとに喋らせるものが無い。
 *
 * ## 局を名指しで選ぶ。**渡す前にも絞る**
 *
 * **1本の物理チャンネルに複数の局が乗っている。** `0:v:0` は「最初に見つけた
 * 映像」でしかないので、MX2 を選んでも MX1 の絵が出うる。実機の T26 を調べると
 * 局が4つ (Eテレ1/2/3 と**ワンセグ**) 並んでいて、ワンセグは 320x180 の H.264 —
 * それを掴む目まである。`0:p:<局>:v:0` なら選んだ局の中から選ぶ。
 *
 * **名指しだけでは足りない。** ffmpeg はその局を `-probesize` のぶん読む間に
 * 見つけられなければ、**そのまま終了する**。実機の tvk (T15) は tvk1/2/3 +
 * ワンセグ + データで、局ごとに14本以上のストリームがあり、400KB では
 * 読み切れずに降りていた:
 *
 *     Failed to set value '0:p:24632:v:0' for option 'map': Invalid argument
 *
 * わざと probesize を下げて、その T15 で測ったもの (3回ずつ):
 *
 *     probesize  20KB   丸ごと 0/3 通る    1局に絞る 3/3
 *     probesize  50KB   丸ごと 0/3 通る    1局に絞る 3/3
 *     probesize 120KB   丸ごと 1/3 通る    1局に絞る 3/3
 *     probesize 400KB   丸ごと 3/3 通る    1局に絞る 3/3
 *
 * **渡す前に1局へ絞れば 20KB でも通る。** 録画と同じ `ServiceFilter` を通すだけで、
 * ffmpeg が受け取るのは局が1つだけの TS になる。局を探す仕事が消えるので、
 * **20KB まで下げてある**。
 *
 * 余裕を見て 100KB にしていたが、6回ずつ測ると縮むぶんが見えた:
 *
 *     100KB   最短 474ms  中央 839ms  (6/6 通る)
 *      20KB   最短 441ms  中央 752ms  (6/6 通る)
 *
 * **中央値の差はばらつき** (放送の GOP 待ち 0〜501ms) だが、**最短どうしの
 * 33ms は固定の費用**。20KB は 0.01 秒ぶんで、絞った TS の PAT は最初の
 * パケットから入っている (`ServiceFilter` が書き直したものを同じ回数だけ出す)
 * ので、探すものが無い。**絞っていなければこの値では落ちる** — 上の表のとおり
 *
 * 名指し (`0:p:<局>`) はそのまま残す。絞ったものに万一違う局が入っていたら、
 * **黙って別の局を映すより、そこで落ちるほうがいい**。
 *
 * ## 多重音声
 *
 * 「多重音声」と呼ばれるものは2通りある。**どちらも、焼くときに1本へ決める。**
 *
 * - **デュアルモノ** … 音声は1本で、左に主音声・右に副音声 (ARIB STD-B32)。
 *   そのままステレオにすると両方同時に鳴るので、選ばれた側を両耳へ配り直す
 *   (`pan`)。**録画と同じ見分け方** (`arib.ts` の `DUAL_MONO`)。録画は左右を
 *   2トラックに分けるが、こちらは器が1つなので片方を採る
 * - **複数の音声** … 音声そのものが2本以上入っている (解説放送など)。
 *   `-map` で何本目かを名指しする
 *
 * 選べるものを組み立てるのは `arib.audioTracks`。**画面には平らな一覧に見せる** —
 * 見ている人にとってはどちらも「音声を選ぶ」1つの操作でしかない。
 *
 * @param program 放送が名乗っている番号 (`NowPlaying.program`)。0以下なら
 *   最初に見つけた映像 (従来どおり)
 * @param smooth 60コマ/秒で出すか。国内アニメだけ false
 * @param audio どの音声を、どちら側で出すか
 */
export function encodeArgs(
    program: number,
    smooth: boolean,
    audio: AudioTrack,
    codec: LiveCodec = 'h264',
): string[] {
    const from = Number.isFinite(program) && program > 0 ? `0:p:${program}` : '0';
    // デュアルモノは片側だけを両耳へ。そのままだと左右から別の言語が同時に鳴る
    const pan =
        audio.side === 'main'
            ? 'pan=stereo|c0=c0|c1=c0'
            : audio.side === 'sub'
              ? 'pan=stereo|c0=c1|c1=c1'
              : null;
    return [
        '-hide_banner',
        /*
         * **失敗だけ残す。** 入口の見出しも進み具合も要らない (見ているのは
         * 焼けない理由だけ)。字幕側は `showinfo` が info で喋るぶん下げられないが、
         * こちらは喋らせるものが無い
         */
        '-loglevel',
        'error',
        '-fflags',
        'nobuffer',
        // 渡す前に1局へ絞ってあるので、これで足りる (上の説明)
        '-probesize',
        '20000',
        '-copyts',
        '-i',
        'pipe:0',
        // インタレ解除。放送は 1080i なので、解かずに渡すと動きが櫛状になる
        '-vf',
        deinterlace(smooth),
        '-map',
        `${from}:v:0`,
        /*
         * **コマ数の上限を言っておく。**
         *
         * `-probesize` を 20KB まで削ったので、ffmpeg は入口でコマ数を読み切れず、
         * 時間の刻み (90kHz) から**でたらめな値**を起こすことがある。x264 は黙って
         * 受けるが、**SVT-AV1 は突っぱねる**:
         *
         *     Svt[error]: Instance 1: The maximum allowed frame rate is 240 fps
         *     [libsvtav1] Error setting encoder parameters: bad parameter
         *
         * 実機で 20KB のまま AV1 を選ぶと 0/3、この上限を付けると 3/3 通った。
         *
         * **固定 (`-r`) ではなく上限 (`-fpsmax`) にする。** 固定すると、放送が
         * 本当に 59.94p だったとき (720p の局) にコマを落とす。上限なら、
         * まともな値のときは何も起きず、でたらめな値のときだけ抑える。
         *
         * 値はインタレ解除の出方そのまま — 放送は 29.97 のインタレなので、
         * フィールドを起こせば 59.94、フレームのままなら 29.97
         */
        '-fpsmax',
        smooth ? '60000/1001' : '30000/1001',
        ...videoArgs(codec),
        // 何本目の音声か。複数入っている放送では 0 が主とは限らない
        '-map',
        `${from}:a:${audio.stream}`,
        ...(pan === null ? [] : ['-af', pan]),
        ...audioArgs(codec),
        '-f',
        'mp4',
        '-movflags',
        '+empty_moov+default_base_moof',
        // 0.05秒ぶんずつ。これ以上細かくすると音声の入らない塊が出る (上の説明)
        '-frag_duration',
        '50000',
        '-flush_packets',
        '1',
        'pipe:1',
    ];
}

/**
 * 映像の焼き方。**見ている人が選べる** (`LiveCodec`)。
 *
 * ## H.264
 *
 * `-tune zerolatency` で B フレームを作らない (作ると必ず遅れる)。
 * **どの端末でも出る**ので既定。
 *
 * ## AV1
 *
 * 設計 (stream.md §1) が最初から狙っていた形。実機は HW エンコーダを持たない
 * (`ffmpeg -hwaccels` が空) が、**44スレッドあるので間に合う**。同じ電波を
 * 40秒ずつ通した実測 (1080i を解いて60コマ/秒):
 *
 *     x264 veryfast   1バイト目 729ms   焼けた尺 38.5秒/41秒
 *     AV1 preset 12   1バイト目 1177ms  焼けた尺 39.1秒/41秒
 *
 * **確かなのは「落ちこぼれない」ことだけ** (焼けた尺が実時間に付いていっている)。
 * 立ち上がりは 0.45 秒ぶん遅い。
 *
 * **量は中身次第で、まだ何とも言えない。** どちらも品質を指定して焼いている
 * (ビットレートを決めていない) ので、出てくる量は場面で動く。実測も揃わなかった:
 *
 *     ある40秒   x264 3.3 Mbit/s   AV1 2.8 Mbit/s   ← AV1 が 15% 小さい
 *     別の25秒   x264 11.6 Mbit/s  AV1 11.4 Mbit/s  ← ほぼ同じ
 *
 * 音声は Opus に替える (`audioArgs`)。
 *
 * `lookahead=0` が要る。SVT-AV1 は既定で先を読むぶん貯めるので、付けないと
 * その貯めがそのまま遅れになる。preset は 12 — これより速い 13 はもう
 * 目に見えて粗く、遅い 10 は間に合わなくなる。
 *
 * **付けてもまだ溜め込む。** 電波が届いてから塊が出るまで H.264 の 0.24〜0.49秒
 * に対し **1.1〜1.5秒** (`captionLead` に実測)。低遅延指定 (`pred-struct=1`) は
 * 実時間に間に合わなくなるので使えない。**AV1 を選ぶと放送の今から1秒ぶん
 * 離れる** — 切り替えにもそう出してある (`LIVE_CODECS`)。
 */
function videoArgs(codec: LiveCodec): string[] {
    if (codec === 'av1') {
        // -g は H.264 と揃える。合流の待ちは鍵フレームの間隔で決まる
        return ['-c:v', 'libsvtav1', '-preset', '12', '-g', '60', '-svtav1-params', 'lookahead=0'];
    }
    /*
     * **H.264 は量を捨てて速さを採る。** AV1 と役割を分けてある — あちらが
     * 「小さく」、こちらが「速く」。
     *
     * `ultrafast` は x264 がいちばん手を抜く設定。**画質は据え置き** (`-crf` を
     * 付けない = 既定の 23) なので、**出てくる絵は今までと同じ**で、量だけ増える。
     *
     * 実機で6回ずつ測ったもの。ばらつきは放送の GOP 待ち (0〜501ms) なので、
     * **短いほうの2つ**を見る:
     *
     *     veryfast  既定      最短 438ms  2番目 535ms   2.5 Mbit/s  ← 前
     *     ultrafast 既定      最短 386ms  2番目 429ms   8.2 Mbit/s  ← これ
     *     ultrafast crf 20    最短 524ms  2番目 584ms  10.7 Mbit/s
     *     ultrafast crf 18    最短 478ms  2番目 511ms  14.6 Mbit/s
     *     superfast crf 18    最短 599ms  2番目 615ms   8.6 Mbit/s
     *
     * **画質を上げると必ず遅くなる。** 最初の1枚が太り、書き出すのに時間が
     * かかるため — `crf 14` は 35.9 Mbit/s で最短 586ms、本当の無劣化 (`-qp 0`)
     * に至っては 235.7 Mbit/s で 643ms だった。**速さが目的なら上げてはいけない。**
     *
     * 8.2 Mbit/s は宅内向けの値。宅外から見るときは AV1 を選ぶ
     */
    return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '60'];
}

/**
 * 音声の焼き方。**AV1 と組むときは Opus。**
 *
 * 設計 (stream.md §1) が狙っていた組み合わせで、**録画と同じ扱い**でもある
 * (`encoder.ts` は前から `libopus -b:a 256k`)。同じ音質なら AAC より小さく、
 * ブラウザは MSE で受け取れる (Chromium で `av01…,opus` を確かめ済み)。
 *
 * **256k は放送に合わせた値。** 元の放送が AAC 256kbps なので、録画側は
 * そこへ揃えてある。ライブだけ 192k で低かったのを、こちらへ寄せる。
 *
 * H.264 は AAC のまま。**どの端末でも出る**ほうを既定にしている以上、
 * 音声まで新しいものに替える理由が無い。
 *
 * どちらも 2ch に落とす。デュアルモノの配り直し (`-af pan=…`) はこの手前で
 * 効いているので、ここへ来るのは既に「出したい音」1本ぶん
 */
function audioArgs(codec: LiveCodec): string[] {
    return codec === 'av1'
        ? ['-c:a', 'libopus', '-b:a', '256k', '-ac', '2']
        : ['-c:a', 'aac', '-b:a', '256k', '-ac', '2'];
}

/**
 * ブラウザに渡す codecs 文字列。**MSE はこれが合っていないと受け取らない。**
 *
 * 中身から起こすのが本筋だが (moov を読めば分かる)、焼き方はこちらで決めて
 * いるので、その組に対応する値を返す。
 *
 * - `avc1.640029` … High profile / Level 4.1。1080p60 まで
 * - `av01.0.08M.08` … Main profile / Level 4.0 / 8bit。同じく 1080p60 まで
 *
 * **音声も組で決まる** (`audioArgs`)。AV1 は Opus、H.264 は AAC
 */
export function codecsFor(codec: LiveCodec): string {
    return codec === 'av1'
        ? 'video/mp4; codecs="av01.0.08M.08,opus"'
        : 'video/mp4; codecs="avc1.640029,mp4a.40.2"';
}

/**
 * **字幕を出すまで待たせる量 (秒)。焼き方で決まるので、ここで決めて画面へ渡す。**
 *
 * 受け側は「いちばん新しく届いている映像」に、この量を足したところへ字幕を置く
 * ([stream.md](../../../docs/stream.md) §5.4)。
 *
 * ## H.264 は待たせない
 *
 * **字幕が届いたときには、その字幕が属する映像はもう届いている。** 放送は
 * 字幕も映像も前もって送るが (字幕は描く手間ぶん、映像は復号器の溜めぶん)、
 * 映像を焼いて包む手間がそれを食う。差し引きで待ちは残らない。
 *
 * **ここは2回外した。値ではなく、見方を間違えた。**
 *
 * - 1回目は「字幕の先回り」だけを見た。映像も先送りされていることを忘れて
 *   いて、0.5秒 待たせた。**局差が消えたように見えたのは偶然** — 字幕と
 *   映像の先回りは局ごとに同じ方向へ動くので、片方だけ見ても揃って見える
 * - 2回目は両方を見て差を採った (0.42秒)。**今度は焼く手間を数え落とした。**
 *   差そのものは実測で 292〜321ms と堅いのに、それを足すのが誤り
 *
 * **どちらも実機の出口どうしを突き合わせて測っていた。** 焼いた mp4 の中身が
 * どの放送時刻に当たるかは多重化器が握っていて外から見えず、別々に起こした
 * ffmpeg は焼き始めの鍵フレームが 0〜0.5秒 ずれる。装置を5通り作って
 * -60〜+450ms とばらけ、同じ局の2回で 150ms 動いた。**測れないものを
 * 測ろうとしていた。**
 *
 * 決めたのは**画面を見た人**。0 / 0.2 / 0.45 秒を出し比べて 0 がいちばん
 * 合った。数えるための仕掛け (`ts/caption-lead.ts`) は、そういうわけで消した。
 *
 * ## AV1 は待たせる
 *
 * **SVT-AV1 が溜め込むぶん、映像だけが遅れて届く。** `lookahead=0` は指定済みで、
 * 低遅延指定 (`pred-struct=1`) は実機で追いつかなくなった (出口が 6秒 → 22秒 と
 * 離れていく)。電波が届いてから塊が出るまで H.264 の 0.24〜0.49秒 に対し
 * 1.1〜1.5秒 かかるので、その差だけ字幕を待たせる。コマ数で変わるのは
 * 溜める量が枚数で決まっているから。
 *
 * **こちらは出し比べていない。** H.264 との差から起こした値なので、
 * ずれていたら合わせ直す
 */
export function captionLead(codec: LiveCodec, smooth: boolean): number {
    if (codec === 'av1') return smooth ? AV1_WAIT : AV1_WAIT_30;
    return 0;
}

/** AV1 で待たせる量 (秒)。60コマ。H.264 との焼く手間の差 */
const AV1_WAIT = 0.9;
/** 同 30コマ。溜める量は枚数で決まるので、コマが半分なら尺は長くなる */
const AV1_WAIT_30 = 1.25;

interface Viewer {
    connection: Connection;
    /** init を渡したか。渡す前に中身を送っても MSE は捨てる */
    ready: boolean;
}

class Session {
    private readonly viewers = new Set<Viewer>();
    private readonly splitter = new Fmp4Splitter();
    private readonly aborter = new AbortController();
    private proc: ReturnType<typeof Bun.spawn> | null = null;
    /** 最後に流した init。途中から入ってきた人に真っ先に渡す */
    private init: Uint8Array | null = null;
    private stopped = false;

    constructor(
        readonly channelType: string,
        readonly channel: string,
        /** 局の内部ID (`services.id`)。相乗りの目印に使う */
        readonly serviceId: number,
        /** 放送が名乗っている番号。**ffmpeg に渡すのはこちら** (NowPlaying の説明) */
        readonly program: number,
        /** 60コマ/秒で出すか。国内アニメだけ false */
        readonly smooth: boolean,
        /** どの音声を、どちら側で出すか */
        readonly audio: AudioTrack,
        /** どの形で焼くか。**見ている人が選ぶ** */
        readonly codec: LiveCodec,
    ) {}

    get empty(): boolean {
        return this.viewers.size === 0;
    }

    /**
     * まだ焼いているか。**畳んだものを掴んだままにしないため。**
     *
     * ffmpeg が降りると畳まれて一覧からも消えるが、**繋いでいる側は同じものを
     * 指したまま**になる。同じ局を選び直しても「もう見ている」と見なされて
     * 何も起きず、**「やり直す」を押しても直らない**
     */
    get alive(): boolean {
        return !this.stopped;
    }

    add(viewer: Viewer): void {
        this.viewers.add(viewer);
        if (this.init !== null) this.hand(viewer, CHANNEL.videoInit, this.init);
    }

    remove(viewer: Viewer): void {
        this.viewers.delete(viewer);
    }

    /**
     * 1つ渡す。**init を渡す前に中身を送らない** (MSE が捨てる)。
     *
     * 中身は詰まったら捨ててよい。**遅れて全部届くより、飛んで今が映るほうがいい** —
     * 放送は待ってくれないので、積むと際限なく太る。init は捨てない
     * (捨てるとその人には以降ずっと絵が出ない)。
     */
    private hand(viewer: Viewer, kind: number, data: Uint8Array): void {
        if (kind === CHANNEL.videoInit) viewer.ready = true;
        else if (!viewer.ready) return;
        viewer.connection.send(kind, 0n, data, kind === CHANNEL.videoMedia);
    }

    /** 焼き始める。**畳むまで戻らない** */
    async run(): Promise<void> {
        const label = `${this.channelType}:${this.channel}`;
        try {
            /*
             * **空きが無ければ待って掛け直す** (`openWhenFree`)。チャンネルを
             * 変える一瞬だけ、前のチャンネルと合わせてチューナーが2本要る —
             * 前のを離してから頼んでいるが、離れたことがエージェントに届くのは
             * 非同期なので重なる瞬間が残る。地上波は2本しかないので、録画か
             * 番組表集めが1本使っていると、そこで断られていた
             */
            const stream = await openWhenFree(
                this.channelType,
                this.channel,
                this.aborter.signal,
                `live ${this.channelType}/${this.channel}`,
                config.priority.live,
                () => this.stopped,
            );

            const proc = Bun.spawn(
                [config.ffmpeg, ...encodeArgs(this.program, this.smooth, this.audio, this.codec)],
                {
                    stdin: 'pipe',
                    stdout: 'pipe',
                    stderr: 'pipe',
                },
            );
            this.proc = proc;

            /*
             * **流し込みと汲み出しを同時に回す。** 順にやると、ffmpeg の
             * 出力を誰も読まないまま入力を書き続けることになり、パイプが詰まって
             * 両方止まる (放送は止まってくれない)。
             *
             * **終わりは ffmpeg の終了で見る。** 汲み出しは相手が死ねば
             * すぐ終わるが、**流し込みは終わらない** — 書き込み先が閉じても
             * 例外にならないことがあり、放送は止まらないので回り続ける。
             * 3つ揃うのを待っていると、死んだことに永久に気づかない
             */
            const running = Promise.all([this.pump(stream, proc), this.drain(proc), this.watch(proc)]);
            await Promise.race([running, proc.exited]);
            // ここまで来たのは ffmpeg が自分で降りたとき。畳んだのなら stopped が立つ
            this.died(label, `ffmpeg が終了しました (${proc.exitCode ?? '不明'})`, '映像を出せませんでした');
        } catch (error) {
            this.died(label, String(error), '選局できませんでした');
        } finally {
            this.stop();
        }
    }

    /**
     * 焼けなくなったことを、**見ている人に伝える。**
     *
     * 伝えずに消えていた頃は、ffmpeg が入口で落ちても画面には何も出ず、
     * **前の絵が貼られたまま6秒たって黒くなる**だけだった (`live-player` の
     * `HOLD_MOST`)。見た目は「切り替えが 6 秒かかった」で、実際には
     * 失敗しているのに、そうとは分からない出方をする。
     *
     * 実機で出たのは tvk (T15) — 局が3つ相乗りしている TS で、`-probesize` が
     * 足りずに `-map 0:p:24632:v:0` を解決できないまま ffmpeg が降りていた。
     *
     * こちらから畳んだとき (`stop`) は言わない。見ている人が居なくなったか、
     * 選び直されたかで、どちらも知らせるようなことではない
     */
    private died(label: string, why: string, message: string): void {
        if (this.stopped) return;
        console.warn(`[live] ${label}: ${why}`);
        this.tell({ type: 'error', message });
    }

    /**
     * エージェントから来た TS を ffmpeg へ。**その局のぶんだけ渡す。**
     *
     * 録画と同じ絞り方 (`ts/service-filter.ts`)。丸ごと渡していた頃は、局が
     * 3つ乗っている TS で ffmpeg が局を見つけられずに降りていた (`encodeArgs`
     * の説明)。
     *
     * **量はほとんど減らない。** 実測は tvk で 17.6 → 16.8 Mbit/s、日テレで
     * 17.3 → 14.5 Mbit/s。相乗りしている局は**同じ ES を指している**ことが
     * 多いので (tvk1/2/3 は同じ中継を流している)、落ちるのは他局ぶんの表と
     * 詰め物だけ。狙いは量ではなく、**ffmpeg に局を探させないこと**。
     *
     * **放送の番号が分からないときは絞らない。** 絞りようが無いので、
     * 丸ごと渡して ffmpeg に最初の映像を採らせる (`encodeArgs` も同じ判断)
     *
     * ## `write` の返りを待つ。**待たないとサーバごと落ちる**
     *
     * bun の `FileSink.write` は、**捌けなければ Promise を返す**
     * (捌けたときは書けた数)。放っておくと、ffmpeg が降りたあとの
     * EPIPE が**誰にも受け取られない転び**になり、bun はそれで
     * **プロセスを終わらせる** — ライブ1本の後始末で、録画まで道連れになる。
     *
     * `try`/`catch` では止まらない。投げられるのではなく、捨てた Promise が
     * あとから転ぶため。実機で落ちた (`captions.ts` の `pump` で EPIPE、
     * 終了コード 1)。同じ形を作って数えると:
     *
     *     write を待たない   15回中 8回 落ちる
     *     write を待つ       15回中 0回
     *
     * 待つのは詰まりの面倒を見ることにもなる。捌けるまで読むのを止めれば
     * いいだけで、放送を落とすことにはならない (汲み出しは別に回っている)
     */
    private async pump(
        stream: ReadableStream<Uint8Array>,
        proc: ReturnType<typeof Bun.spawn>,
    ): Promise<void> {
        const writer = proc.stdin as import('bun').FileSink;
        const filter = this.program > 0 ? new ServiceFilter(this.program) : null;
        try {
            for await (const chunk of chunks(stream)) {
                if (this.stopped) break;
                const out = filter === null ? chunk : filter.filter(chunk);
                if (out.length === 0) continue;
                // **書けたことを待つ** (上の説明)。待たないと、転んだときに拾い手が居ない
                await writer.write(out);
                await writer.flush();
            }
        } finally {
            try {
                writer.end();
            } catch {
                // もう閉じている
            }
        }
    }

    /** ffmpeg が出した fMP4 を割って配る */
    private async drain(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
        for await (const chunk of chunks(proc.stdout as ReadableStream<Uint8Array>)) {
            for (const segment of this.splitter.feed(chunk)) {
                if (segment.kind === 'init') {
                    this.init = segment.data;
                    for (const viewer of this.viewers) this.hand(viewer, CHANNEL.videoInit, segment.data);
                } else {
                    for (const viewer of this.viewers) this.hand(viewer, CHANNEL.videoMedia, segment.data);
                }
            }
        }
    }

    /**
     * ffmpeg の言い分から失敗だけ残す。
     *
     * 焼けない理由 (音声が無い・解像度が変わった) はここにしか出ない。
     * 捨てていると「映像が出ない」としか分からなくなる。
     *
     * `-loglevel error` にしてあってもなお、復号器は直せた程度のことまで
     * 喋る (放送の欠けは日常的にある)。**残すのは本当に失敗した行だけ**
     */
    private async watch(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
        for await (const line of lines(proc.stderr as ReadableStream<Uint8Array>)) {
            if (TROUBLE.test(line)) {
                console.warn(`[live] ${this.channelType}:${this.channel} ffmpeg: ${line.trim()}`);
            }
        }
    }

    tell(notice: Notice): void {
        for (const viewer of this.viewers) this.tellOne(viewer, notice);
    }

    private tellOne(viewer: Viewer, notice: Notice): void {
        viewer.connection.send(CHANNEL.control, 0n, new TextEncoder().encode(JSON.stringify(notice)));
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.aborter.abort();
        this.proc?.kill();
        sessions.delete(
            key(this.channelType, this.channel, this.serviceId, this.smooth, this.audio, this.codec),
        );
    }
}

/**
 * 焼いているものの目印。**局・コマ数・音声まで含める。**
 *
 * 1本の物理チャンネルに複数の局が乗っているので、チャンネルだけでは足りない —
 * 局を名指しで選んでいる以上、出てくる絵が局ごとに違う。コマ数も同じで、
 * 国内アニメを見ている人と実写を見ている人では違う。**音声も同じ** —
 * 二カ国語を主音声で見ている人と副音声で見ている人は別のものを焼いている。
 * **焼き方 (H.264 / AV1) も同じ** — 選んだ形が違えば別のものになる。
 * 混ぜると片方が意図しないものを見ることになる。チューナーはエージェント側で
 * 相乗りになるので、増えるのは ffmpeg だけ。
 */
const key = (
    type: string,
    channel: string,
    serviceId: number,
    smooth: boolean,
    audio: AudioTrack,
    codec: LiveCodec,
) => `${type}:${channel}:${serviceId}:${smooth ? 60 : 30}:${audio.id}:${codec}`;
const sessions = new Map<string, Session>();

/** 見に行く。既に同じものを焼いていれば相乗りする */
function watch(
    channelType: string,
    channel: string,
    serviceId: number,
    now: NowPlaying,
    codec: LiveCodec,
    viewer: Viewer,
): Session {
    const id = key(channelType, channel, serviceId, now.smooth, now.audio, codec);
    let session = sessions.get(id);
    if (session === undefined) {
        session = new Session(channelType, channel, serviceId, now.program, now.smooth, now.audio, codec);
        sessions.set(id, session);
        // 畳むのは見ている人が居なくなったとき。ここでは待たない
        void session.run();
    }
    session.add(viewer);
    return session;
}

/**
 * 誰も繋いでこなかったときに畳むまで (ms)。
 *
 * **画面はすぐ来る** — 実測で、ページを組みはじめてから WebSocket が繋がる
 * まで 160ms。それでも来ないなら開いたそばから離れた人なので、掴んだままに
 * しない (ライブは録画の次に強いので、放っておくと番組表集めを蹴り続ける)。
 */
const WARM_WAIT = 8_000;

/**
 * **画面が繋いでくる前に焼きはじめる。**
 *
 * 開いてから絵が出るまでを実機で割ると ([stream.md](../../../docs/stream.md) §4):
 *
 *     画面が動き出して札を取り、WebSocket が繋がるまで   160ms
 *     ffmpeg の立ち上がり                              530ms
 *     放送の I フレーム待ち                          0〜501ms
 *
 * **前の 160ms は後ろと重ねられる。** これから開くのがどの局かは、画面を
 * 組む時点で分かっている — 番組表から名指しで来たか (`?service=`)、画面が
 * 覚えている前回の局か (`LAST_COOKIE`)、一覧の先頭。
 *
 * **1枚も出ないうちに繋がるので、合流の待ちは付かない。** 焼いたものは
 * 鍵フレームから始まるが、それが出るのは 530ms 後なので、160ms で来る画面は
 * まだ何も渡されていない状態で乗る。
 *
 * 待たない・投げない。掴めなくても画面はいつもどおり繋いでくるので、
 * そのとき改めて開くだけ。
 */
export function warm(
    channelType: string,
    channel: string,
    serviceId: number,
    audio?: string,
    codec: LiveCodec = 'h264',
): void {
    if (channelType === '' || channel === '' || !Number.isFinite(serviceId)) return;

    const now = nowPlaying(serviceId, audio);
    const id = key(channelType, channel, serviceId, now.smooth, now.audio, codec);
    // 既に焼いていれば何もしない。開き直すたびに増やさない
    if (sessions.has(id)) return;

    const session = new Session(channelType, channel, serviceId, now.program, now.smooth, now.audio, codec);
    sessions.set(id, session);
    void session.run();

    /*
     * **誰も来なければ自分で畳む。** 見ている人が居なくなったら畳む仕掛け
     * (`attend` の `leave`) は、**1人も来なかった場合には動かない**
     */
    const timer = setTimeout(() => {
        if (session.empty) session.stop();
    }, WARM_WAIT);
    timer.unref?.();
}

/**
 * 1本ぶんの受け持ち。**繋いでいる間だけチューナーを掴む。**
 *
 * 接続そのものが在席の印になる (`stream.md` の「誰が見ているかが分かる」)。
 * HTTP のストリームだと切断の検出が遅れるが、WebSocket なら閉じた時点で分かる。
 */
export function attend(connection: Connection): void {
    const viewer: Viewer = { connection, ready: false };
    let current: Session | null = null;
    /** いま字幕を受けている局。**焼き方が変わっても、局が同じなら切らない** */
    let captionKey = '';
    let dropCaptions: (() => void) | null = null;

    const leave = () => {
        if (current === null) return;
        current.remove(viewer);
        // **最後の1人が抜けたら畳む。** 残すとチューナーを掴んだままになる
        if (current.empty) current.stop();
        current = null;
    };

    /**
     * 字幕を受け直す。**局が同じなら何もしない。**
     *
     * 字幕は局で決まるので、音声を選び直しただけで切ってはいけない。
     * 切ると ffmpeg を起こし直すことになり、次の字幕が出るまで数十秒あく
     * (字幕は次が来るまで出しっぱなしのものなので、途切れがそのまま見える)
     */
    const followCaptions = (
        channelType: string,
        channel: string,
        serviceId: number,
        program: number,
        track: number,
    ) => {
        const id = `${channelType}:${channel}:${serviceId}:${track}`;
        if (id === captionKey) return;
        dropCaptions?.();
        captionKey = id;
        const tell = (notice: Notice) =>
            connection.send(CHANNEL.control, 0n, new TextEncoder().encode(JSON.stringify(notice)));
        dropCaptions = watchCaptions(
            channelType,
            channel,
            serviceId,
            program,
            track,
            (caption) => {
                const { kind, pts, data } = frame(caption);
                connection.send(kind, pts, data);
            },
            // 選べる字幕。**1枚も届いていなくても分かる** (入口の見出しに出ている)
            (tracks) => tell({ type: 'captions', tracks, track }),
        );
    };

    connection.onmessage = (message) => {
        if (message.type !== 'tune') return;
        const channelType = typeof message.channelType === 'string' ? message.channelType : '';
        const channel = typeof message.channel === 'string' ? message.channel : '';
        const serviceId = Number(message.serviceId);
        const audio = typeof message.audio === 'string' ? message.audio : undefined;
        // 知らない形を頼まれたら H.264。**画面から来る値をそのまま信じない**
        const codec: LiveCodec = message.codec === 'av1' ? 'av1' : 'h264';
        // 字幕は映像とは別の ffmpeg なので、選び直しても映像は焼き直しにならない
        const caption = Number.isInteger(message.caption) ? Math.max(0, Number(message.caption)) : 0;
        if (channelType === '' || channel === '') return;

        const now = nowPlaying(serviceId, audio);

        /*
         * **物理チャンネルが変わるなら、前のを先に離す。**
         *
         * 字幕は映像とは別に TS をもう1本もらう (`captions.ts`)。前のチャンネルを
         * 掴んだまま新しいチャンネルの字幕を頼むと、**その一瞬だけチューナーが
         * 1本余分に要る** — 地上波は2本しかないので、番組表集めが1本使っていると
         * そこで断られる (実機で `[captions] GR:T15: チューナーに空きがありません`)。
         *
         * 離すのは物理チャンネルが変わるときだけ。同じチャンネルの中で局や音声を
         * 選び直すぶんには、エージェント側で相乗りになるので余分は要らない
         */
        if (current !== null && (current.channelType !== channelType || current.channel !== channel)) {
            leave();
        }

        /*
         * **字幕は映像より先に面倒をみる。** 映像とは別建てなので、焼き方が同じでも
         * (=下の早戻りに掛かっても) 字幕だけ選び直せる。局が同じなら
         * `followCaptions` の中で何もしない
         */
        followCaptions(channelType, channel, serviceId, now.program, caption);

        /*
         * **同じものを焼いているなら、そのまま。**
         *
         * ただし**畳まれていないことを確かめる** — ffmpeg が降りたセッションを
         * 指したままだと「もう見ている」と見なされ、選び直しても「やり直す」を
         * 押しても新しく起こさない。画面は待ち続けるだけになる
         */
        if (
            current?.alive === true &&
            current.channelType === channelType &&
            current.channel === channel &&
            current.serviceId === serviceId &&
            current.smooth === now.smooth &&
            current.audio.id === now.audio.id &&
            current.codec === codec
        ) {
            return;
        }

        leave();

        /*
         * **知らせるのも印を戻すのも、乗る前に済ませる。**
         *
         * `watch` は既に誰かが見ているチャンネルなら、その場で持っている init を
         * 渡す (`Session.add`)。そのあとで `ready` を戻していた頃は、**渡した直後の
         * init を無かったことにして**いた — 以降の中身が全部 `hand` で止まり、
         * 相乗りしたときだけ絵が出ない。
         *
         * `tuned` も先に出す。器を作るのは画面側で、init はそれより先には使えない。
         */
        viewer.ready = false;
        const notice: Notice = {
            type: 'tuned',
            channelType,
            channel,
            codecs: codecsFor(codec),
            codec,
            lead: captionLead(codec, now.smooth),
            audio: now.audio.id,
            audios: now.audios,
        };
        connection.send(CHANNEL.control, 0n, new TextEncoder().encode(JSON.stringify(notice)));
        current = watch(channelType, channel, serviceId, now, codec, viewer);
    };

    connection.onclose = () => {
        leave();
        dropCaptions?.();
        dropCaptions = null;
        captionKey = '';
    };
}

export interface NowPlaying {
    /**
     * 放送が名乗っている番号 (ARIB の service_id = TS の program_number)。
     * **`services.id` とは別物** — あちらは `network_id * 100000 + service_id` の
     * 内部IDで、TS の中には出てこない。**内部IDを渡すと** ffmpeg はその番号の局を
     * 探して見つけられず、**絵も音も出ない** (実機でやった)。ffmpeg に渡すのはこちら
     */
    program: number;
    smooth: boolean;
    /** 選べる音声。画面へそのまま送る */
    audios: AudioTrack[];
    /** そのうち焼くもの */
    audio: AudioTrack;
}

/**
 * いま流れている番組から、焼き方を決める。**番組表を頼りにする。**
 *
 * - 局の番号 … ffmpeg に名指しさせる `program_number` (`NowPlaying.program`)
 * - コマ数 … 国内アニメだけ倍にしない (`smoothMotionFor`)。**分からなければ
 *   実写として扱う** — 放送の大半は実写で、アニメを実写扱いにしても絵は
 *   変わらないが、逆は動きが落ちる
 * - 音声 … 番組表の `audios` から、選べるものを組み立てる (`arib.audioTracks`)。
 *   **古い行には `audios` が入っていない**ので、そのときは `audio_type` だけで
 *   デュアルモノかどうかを見る。どちらも無ければ「そのまま出す」1つ
 *
 * @param serviceId 局の内部ID (`services.id`)。画面から届くのはこれ
 * @param wanted 画面が頼んできた音声 (`AudioTrack.id`)。無いものなら先頭
 */
function nowPlaying(serviceId: number, wanted: string | undefined): NowPlaying {
    const decide = (program: number, genres: string | null, audios: Audio[]): NowPlaying => {
        const tracks = audioTracks(audios);
        return {
            program,
            smooth: smoothMotionFor(genres),
            audios: tracks,
            audio: pickTrack(tracks, wanted),
        };
    };

    if (!Number.isFinite(serviceId)) return decide(0, null, []);
    const at = Date.now();
    const service = queryOne<{ service_id: number }>(
        `SELECT service_id FROM services WHERE id = ?`,
        serviceId,
    );
    const program = queryOne<{
        genre_detail: string | null;
        audio_type: number | null;
        audios: string | null;
    }>(
        `SELECT genre_detail, audio_type, audios FROM programs
         WHERE service_id = ? AND start_at <= ? AND end_at > ?`,
        serviceId,
        at,
        at,
    );

    return decide(service?.service_id ?? 0, program?.genre_detail ?? null, parseAudios(program));
}

/**
 * 番組表が持っている音声の構成を読む。**壊れていても止まらない。**
 *
 * `audios` は放送から拾ったものを JSON で持っているだけなので、形が違うことは
 * ありうる。読めなければ `audio_type` に落とし、それも無ければ何も無いことにする —
 * どの道 `audioTracks` が「そのまま出す」1つを返す
 */
function parseAudios(row: { audio_type: number | null; audios: string | null } | undefined): Audio[] {
    if (row === undefined) return [];
    try {
        const parsed: unknown = JSON.parse(row.audios ?? 'null');
        if (Array.isArray(parsed) && parsed.length > 0) return parsed as Audio[];
    } catch {
        // 読めなかった。下の `audio_type` で見る
    }
    return row.audio_type === null ? [] : [{ componentType: row.audio_type }];
}

/** テスト用。掴んだままのものを残さない */
export function stopAll(): void {
    for (const session of [...sessions.values()]) session.stop();
}
