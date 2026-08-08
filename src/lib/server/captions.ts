/**
 * ライブ視聴の字幕。**絵にして、変わったときだけ配る。**
 *
 *     エージェント (MPEG-TS) → ffmpeg (sub2video → PNG) → 割る → WebSocket → canvas
 *
 * [stream.md](../../../docs/stream.md) §5.2 にあたる第2段階。放送に絵は流れて
 * こない — 乗っているのは文字と「どこに・どの大きさで・何色で・背景の箱つきで」
 * という指定で、テレビはそれを見て毎回自分で描いている。libaribcaption に同じように
 * 描かせたものが `-sub_type bitmap` で、**それが「放送どおりの字幕の絵」**になる。
 * 外字もここでは絵として出るので、対応表の取りこぼしが起きない。
 *
 * 描画系を録画と共通にしてあるので、**録画で見たものとライブで見たものが同じ絵**に
 * なる。ブラウザ側で B24 を解く道 (aribb24.js) を採らなかったのはこれが理由
 * (stream.md §6)。
 *
 * ## PNG は ffmpeg に組ませる
 *
 * 設計では生の RGBA を受け取って、denpa が切り抜き・256色化・パレット PNG の
 * 組み立てまでやることにしていた。**実機で測ったら、ffmpeg に PNG まで
 * 畳ませるほうが速かった。** 同じ TS 30秒ぶんを通したときの実測:
 *
 *     生の RGBA   1.94秒   406 MB    1枚 8.29 MB
 *     PNG         1.05秒   1.76 MB   1枚 36 KB    ← これ
 *     256色 PNG   4.30秒   0.94 MB   1枚 19 KB
 *
 * **生のほうが遅いのは、書く量が桁違いだから** (毎秒 13MB をパイプに流す)。
 * 256色に落とせば半分になるが、そのために CPU を4倍払うことになる。
 * denpa 側の切り抜き・色数落とし・PNG 組み立ては、まるごと要らなくなった。
 *
 * ## 変わったときだけ送る
 *
 * sub2video は**同じ絵を何度も出す**。実機で数えると毎分98枚出てくるが、
 * **中身が変わっているのは18回だけ**だった (残り8割は出し直し)。そのまま流すと
 * 毎秒 57KB、変わったときだけなら毎秒 8.3KB。宅外から見ることを考えると、
 * ここは落とす価値がある。
 *
 * ## 出てきた絵だけを頼りにする
 *
 * 以前は `showinfo` に時刻と「空かどうか」を喋らせ、**標準エラーの行と標準出力の
 * PNG を来た順に組にして**いた。**数が合わない。** 実機の日テレで70秒測ると
 * PNG 77枚に対して showinfo は79行で、余った2行のぶんだけ**以降ずっと1つずれる**
 * (一度ずれたら戻らない)。ずれると、字幕が出た枚に1つ前の「空」が当たって
 * **消す**に化け、その字幕は次の出し直しまで出ない。**字幕が1秒ほど遅れて出て、
 * 消えるのも遅れる**という、報告そのままの出方をする。
 *
 * 余りが出るのは、フィルタを通った枚がそのまま出てくるとは限らないため
 * (同じ時刻の枚は多重化のところで落ちる)。**別々の口から来るものを位置で
 * 突き合わせている限り、ずれ得る。**
 *
 * いまは `showinfo` を外し、**PNG だけを見る**。空の枚も、そのまま送って
 * 受け側に描かせる — 全部透明な絵を重ねるのは「消す」と同じ結果になる。
 * 空の1枚は 10.6KB で、実機の頻度 (毎分9回くらい) なら毎秒 1.6KB ぶん増える。
 * **ずれ得ない作りのほうが、その 1.6KB より価値がある。**
 *
 * 外したぶん ffmpeg の標準エラーも静かになった (40秒で 383行 → 109行)。
 * 入口の見出しは残るので、選べる字幕は今までどおり分かる (`TrackList`)。
 *
 * ## 局ごとに1本。**音声の選び方では分けない**
 *
 * 字幕は局で決まるので、同じ局を見ている人は音声が違っても同じものを見る。
 * 焼き方 (`live.ts` の目印) にはコマ数と音声が入っているが、こちらは
 * **局までで足りる**。音声を選び直しても字幕は途切れない。
 */

import { type CaptionTrack, CHANNEL } from '$lib/live';
import { ServiceFilter } from '$lib/ts/service-filter';
import { config } from './config';
import { chunks, lines } from './stream';
import { openWhenFree } from './tuner';

/**
 * 字幕を描く画面の大きさ。
 *
 * **指定は要る。** 無いと libaribcaption は 1440x1080 (PROFILE_A) とみなすので、
 * 1920x1080 の放送では字幕だけ横に伸びる。受け側は映像の枠に合わせて伸ばすだけ
 * なので、放送が 1440x1080 でもここを 1920x1080 にしておけば辻褄が合う
 * (どちらも表示は 16:9)。
 */
export const CANVAS = { width: 1920, height: 1080 };

/** 字幕に使う字。録画と同じものを使う (見た目を揃えるため) */
const FONTS = 'Rounded M+ 1m for ARIB';

/** PNG の署名。塊の切れ目を見つけるのに使う */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

/** 記録に残す価値のある行。**それ以外は入り口の説明なので捨てる** */
export const TROUBLE = /error|Error|failed|Failed|Cannot|Unable|No such|Invalid data/;

/**
 * 字幕を絵で取り出す ffmpeg の引数。
 *
 * - `-copyts` … **元TSの時刻をそのまま持つ。** 受け側はこの時刻を使わないが
 *   (`live.ts` の `captionLead`)、外すと ffmpeg は字幕1枚目を 0 秒として数え直す。
 *   映像側と物差しが揃わなくなり、**サーバ側で2つの出口を突き合わせて測れなく
 *   なる** — 待たせる量はそうやって測った値なので、外さない
 * - `-sub_type bitmap` … 文字ではなく絵で受け取る。描くのは libaribcaption
 * - `-canvas_size` … 上の説明。無いと 1440x1080 とみなされる
 * - `null` … **何もしないフィルタ。** 字幕をフィルタに通すこと自体が目的で
 *   (それで sub2video が働く)、通す先は何でもよい。ここが `showinfo` だった
 *   頃は、その行と PNG を組にしていて**ずれていた** (上の説明)
 * - `-fps_mode passthrough` … 出てきた枚をそのまま出す。詰め直させない
 * - `image2pipe` + `png` … **PNG まで ffmpeg に組ませる** (上の説明)
 *
 * @param program 放送が名乗っている番号 (`live.ts` の `NowPlaying.program`)。
 *   0以下なら最初に見つけた字幕
 * @param track その局の中で何本目の字幕を出すか。**言語が複数ある放送**では
 *   2本以上乗っている (`TrackList`)
 */
export function captionArgs(program: number, track = 0): string[] {
    const from = Number.isFinite(program) && program > 0 ? `0:p:${program}:s:${track}` : `0:s:${track}`;
    return [
        '-hide_banner',
        '-nostats',
        /*
         * **`-loglevel` を下げない。** 選べる字幕は**入口の見出し**から拾って
         * いて (`TrackList`)、あれは info で出る。`error` に絞ると、字幕を
         * 持っている放送でも切り替えが出せなくなる。騒がしいぶんは読む側で
         * 落とす (`watch`)
         */
        '-copyts',
        '-sub_type',
        'bitmap',
        '-canvas_size',
        `${CANVAS.width}x${CANVAS.height}`,
        '-font',
        FONTS,
        '-fflags',
        'nobuffer',
        // 映像側と同じ。渡す前に1局へ絞ってあるので、これで足りる (live.ts)
        '-probesize',
        '100000',
        '-i',
        'pipe:0',
        // 字幕をフィルタに通すと1枚ずつ映像フレームになる (sub2video)
        '-filter_complex',
        `[${from}]null[v]`,
        '-map',
        '[v]',
        '-fps_mode',
        'passthrough',
        '-f',
        'image2pipe',
        '-c:v',
        'png',
        '-pix_fmt',
        'rgba',
        'pipe:1',
    ];
}

/**
 * 字幕1枚。
 *
 * **いつ出すかは持たない。** 受け側は「いま映っている絵 + 待たせる量」に置く
 * (`live.ts` の `captionLead`)。放送の時刻を添えても、受け側の mp4 は
 * 0 から始まるので物差しが違う。時刻を添えるために `showinfo` を読んでいた頃は、
 * その行と絵がずれて字幕が遅れた (上の説明)
 */
export interface Caption {
    /** パレットではない RGBA の PNG。画面まるごとの大きさ */
    data: Uint8Array;
}

export type CaptionListener = (caption: Caption) => void;
/** 選べる字幕が分かったときに呼ばれる。**1枚も来ていなくても分かる** */
export type TrackListener = (tracks: CaptionTrack[]) => void;

/**
 * 繋がったバイト列から PNG を1枚ずつ取り出す。
 *
 * **`IEND` まで来たらその場で出す。** 次の署名を待って切っていた頃は、
 * **1枚が次の1枚に足止めされていた** — 字幕が次に変わるまで前の字幕が出ない
 * ので、間隔の空く番組ほど遅れる (実機で「字幕が遅い」として出た)。
 *
 * PNG は `[8バイトの署名][かたまり…]` で、かたまりは
 * `[4バイトの長さ][4バイトの種別][中身][4バイトの CRC]`。`IEND` が終わりの印。
 */
export class PngSplitter {
    private buffer = new Uint8Array(0);

    feed(chunk: Uint8Array): Uint8Array[] {
        const joined = new Uint8Array(this.buffer.length + chunk.length);
        joined.set(this.buffer);
        joined.set(chunk, this.buffer.length);
        this.buffer = joined;

        const out: Uint8Array[] = [];
        for (;;) {
            // 署名の前に来たごみは捨てる
            const head = this.find();
            if (head < 0) {
                // 署名の一部が末尾に掛かっているかもしれないぶんだけ残す
                if (this.buffer.length > SIGNATURE.length) {
                    this.buffer = this.buffer.slice(this.buffer.length - SIGNATURE.length + 1);
                }
                break;
            }
            if (head > 0) this.buffer = this.buffer.slice(head);

            const end = this.end();
            if (end < 0) break;
            out.push(this.buffer.slice(0, end));
            this.buffer = this.buffer.slice(end);
        }
        return out;
    }

    /** 先頭の署名の位置。無ければ -1 */
    private find(): number {
        for (let i = 0; i + SIGNATURE.length <= this.buffer.length; i++) {
            if (
                this.buffer[i] === SIGNATURE[0] &&
                this.buffer[i + 1] === SIGNATURE[1] &&
                this.buffer[i + 2] === SIGNATURE[2] &&
                this.buffer[i + 3] === SIGNATURE[3]
            ) {
                return i;
            }
        }
        return -1;
    }

    /** 先頭の PNG の終わり (`IEND` の後ろ)。まだ揃っていなければ -1 */
    private end(): number {
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
        let at = 8;
        for (;;) {
            // 長さ4 + 種別4 + CRC4
            if (at + 12 > this.buffer.length) return -1;
            const size = view.getUint32(at);
            const type = String.fromCharCode(
                this.buffer[at + 4],
                this.buffer[at + 5],
                this.buffer[at + 6],
                this.buffer[at + 7],
            );
            const next = at + 12 + size;
            if (next > this.buffer.length) return -1;
            if (type === 'IEND') return next;
            at = next;
        }
    }
}

/** ffmpeg が入口の見出しに書く行 */
const PROGRAM = /^\s*Program (\d+)/;
const STREAM = /^\s*Stream #0:(\d+)\[0x[0-9a-f]+\](?:\((\w+)\))?: (\w+):/;

/**
 * ffmpeg の入口の見出しから、その局の字幕ストリームを拾う。
 *
 * **字幕が1枚も来ていなくても、あることは分かる。** 届いてから画面に
 * 切り替えを出していた頃は、**間隔の空く番組を開くとボタンが出なかった**
 * (実機の「みんなの手話」。番組表には [字] と出ているのに出ない)。
 *
 * ついでに**何本あるか**も分かる。言語が複数ある放送はここで2本になる。
 */
export class TrackList {
    private inProgram = false;
    private readonly found: CaptionTrack[] = [];

    /** @param program 放送が名乗っている番号。0以下なら最初に見つけた1本 */
    constructor(private readonly program: number) {}

    /** 1行食わせる。**中身が増えたら true** */
    feed(line: string): boolean {
        const program = line.match(PROGRAM);
        if (program !== null) {
            this.inProgram = Number(program[1]) === this.program;
            return false;
        }
        const stream = line.match(STREAM);
        if (stream === null || stream[3] !== 'Subtitle') return false;
        // 局を名指ししないときは、最初に見つけた1本だけ
        if (this.program > 0 ? !this.inProgram : this.found.length > 0) return false;

        const lang = stream[2] ?? null;
        const index = this.found.length;
        this.found.push({ index, lang, label: label(index, lang) });
        return true;
    }

    get tracks(): CaptionTrack[] {
        return this.found;
    }
}

/** ISO 639-2 のうち字幕で出てくるもの。`arib.ts` の表と揃えてある */
const LANGUAGE: Record<string, string> = {
    jpn: '日本語',
    eng: '英語',
    kor: '韓国語',
    zho: '中国語',
    spa: 'スペイン語',
    por: 'ポルトガル語',
    fra: 'フランス語',
    deu: 'ドイツ語',
};

function label(index: number, lang: string | null): string {
    const head = index === 0 ? '字幕' : `字幕${index + 1}`;
    if (lang === null) return head;
    return `${head} (${LANGUAGE[lang] ?? lang})`;
}

/**
 * 局1つぶんの字幕。**見ている人が居る間だけ回す。**
 *
 * 焼き方 (`live.ts` の `Session`) とは別に数える。あちらの目印にはコマ数と音声が
 * 入っているが、字幕は局までで決まるため — 音声を選び直しても途切れさせない。
 */
class Captions {
    private readonly listeners = new Set<CaptionListener>();
    private readonly watchers = new Set<TrackListener>();
    private readonly splitter = new PngSplitter();
    /** 字幕がどれだけ先に来ているか。**局ごとに違うので数える** */
    private readonly aborter = new AbortController();
    private proc: ReturnType<typeof Bun.spawn> | null = null;
    /**
     * いま出ている1枚。**途中から入ってきた人に真っ先に渡す。**
     *
     * 字幕は次が来るまで出しっぱなしなので、渡さないとその人には
     * 次の字幕まで何も出ない (数十秒あく)
     */
    private showing: Caption | null = null;
    /** 前に配った絵。**同じものを配り直さない** (8割が出し直し) */
    private last: string | null = null;
    private stopped = false;

    /** 入口の見出しから拾った、選べる字幕 */
    private readonly list: TrackList;

    constructor(
        readonly channelType: string,
        readonly channel: string,
        readonly serviceId: number,
        readonly program: number,
        /** その局の中で何本目を出すか */
        readonly track: number,
    ) {
        this.list = new TrackList(program);
    }

    get empty(): boolean {
        return this.listeners.size === 0;
    }

    add(listener: CaptionListener, onTracks: TrackListener): void {
        this.listeners.add(listener);
        this.watchers.add(onTracks);
        if (this.list.tracks.length > 0) onTracks(this.list.tracks);
        if (this.showing !== null) listener(this.showing);
    }

    remove(listener: CaptionListener, onTracks: TrackListener): void {
        this.listeners.delete(listener);
        this.watchers.delete(onTracks);
    }

    async run(): Promise<void> {
        try {
            /*
             * **空きが無ければ待って掛け直す** (`openWhenFree`)。字幕は映像とは
             * 別に TS をもう1本もらうので、チャンネルを変える一瞬だけ2本要る。
             * 一度断られたら終わりにしていた頃は、**そのチャンネルの字幕が
             * それきり出なかった** — 見ている側は局を選び直すまで戻せない
             */
            const stream = await openWhenFree(
                this.channelType,
                this.channel,
                this.aborter.signal,
                `live ${this.channelType}/${this.channel} 字幕`,
                config.priority.live,
                () => this.stopped,
            );
            const proc = Bun.spawn([config.ffmpeg, ...captionArgs(this.program, this.track)], {
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
            });
            this.proc = proc;
            await Promise.all([this.pump(stream, proc), this.drain(proc), this.watch(proc)]);
        } catch (error) {
            /*
             * **字幕が出せなくても映像は止めない。** 字幕の無い番組も、
             * 字幕を出せない環境も普通にあるので、ここで諦めても実害は
             * 「字幕が出ない」だけ
             */
            if (!this.stopped) console.warn(`[captions] ${this.channelType}:${this.channel}: ${error}`);
        } finally {
            this.stop();
        }
    }

    /** その局のぶんだけ渡す。映像側と同じ絞り方 (`live.ts` の `encodeArgs`) */
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
                /*
                 * **書けたことを待つ。** 待たずに捨てると、ffmpeg が降りたあとの
                 * EPIPE が誰にも受け取られない転びになり、**サーバごと落ちる** —
                 * 実機でここが落ちた (`live.ts` の `pump` に実測)
                 */
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

    /** 出てきた PNG を配る。**組にするものは無い** (上の説明) */
    private async drain(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
        for await (const chunk of chunks(proc.stdout as ReadableStream<Uint8Array>)) {
            for (const png of this.splitter.feed(chunk)) this.deliver(png);
        }
    }

    /**
     * 標準エラーから、選べる字幕と失敗を拾う。
     *
     * **`-loglevel` を下げられない**ので (入口の見出しが info)、要らない行も
     * 流れてくる。**残すのは失敗だけ** — 全部出すと、選局のたびに数十行が
     * 記録に積まれて読めなくなる
     */
    private async watch(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
        for await (const line of lines(proc.stderr as ReadableStream<Uint8Array>)) {
            /*
             * **選べる字幕は入口の見出しに出ている。** 1枚も来ていなくても
             * 分かるので、画面は待たずに切り替えを出せる (間隔の空く番組で
             * ボタンが出なかったのはこれを見ていなかったため)
             */
            if (this.list.feed(line)) {
                for (const watcher of this.watchers) watcher(this.list.tracks);
                continue;
            }
            if (TROUBLE.test(line)) {
                console.warn(`[captions] ${this.channelType}:${this.channel} ffmpeg: ${line.trim()}`);
            }
        }
    }

    /**
     * 1枚配る。**同じ絵は配り直さない。**
     *
     * sub2video は同じものを何度も出すので (実機で毎分98枚のうち中身が変わるのは
     * 18回)、そのまま流すと帯域が7倍になる。
     *
     * **空の枚も配る。** 全部透明な絵を重ねるのは「消す」と同じ結果になる。
     * 空かどうかを別の口 (showinfo) から聞きに行くと組がずれる (上の説明)
     */
    private deliver(png: Uint8Array): void {
        const key = Bun.hash(png).toString(36);
        if (key === this.last) return;
        this.last = key;
        this.hand({ data: png });
    }

    private hand(caption: Caption): void {
        this.showing = caption;
        for (const listener of this.listeners) listener(caption);
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.aborter.abort();
        this.proc?.kill();
        running.delete(key(this.channelType, this.channel, this.serviceId, this.track));
    }
}

const key = (type: string, channel: string, serviceId: number, track: number) =>
    `${type}:${channel}:${serviceId}:${track}`;
const running = new Map<string, Captions>();

/**
 * 字幕を受け取り始める。**返ってくるのはやめ方。**
 *
 * 同じ局を見ている人が居れば相乗りする。最後の1人が抜けたら ffmpeg を畳む。
 */
export function watchCaptions(
    channelType: string,
    channel: string,
    serviceId: number,
    program: number,
    track: number,
    listener: CaptionListener,
    onTracks: TrackListener,
): () => void {
    const id = key(channelType, channel, serviceId, track);
    let captions = running.get(id);
    if (captions === undefined) {
        captions = new Captions(channelType, channel, serviceId, program, track);
        running.set(id, captions);
        void captions.run();
    }
    captions.add(listener, onTracks);

    const held = captions;
    return () => {
        held.remove(listener, onTracks);
        if (held.empty) held.stop();
    };
}

/**
 * 送る形にする。**頭に置き場所を付ける** (stream.md §5.3)。
 *
 *     [2:x][2:y][2:w][2:h][PNG...]
 *
 * いまは画面まるごとを送るので x,y は 0 だが、**あとで切り抜くようにしても
 * 受け側を変えずに済む**ように持たせてある。
 *
 * **いつ出すかは添えない** (時刻は 0 で置く)。絶対の時刻 (放送の PTS) を
 * 乗せる枠は取り決めにあるが、受け側はそれを使わない — mp4 は必ず 0 から
 * 始まり、その 0 がどの放送時刻にあたるかは多重化器の都合で決まるので、
 * 物差しが違う。受け側は**いま映っている絵から、決まった量だけ
 * 待たせて**出す (`live.ts` の `captionLead`)。「いま焼いている絵より何ms前か」を
 * 添えていたこともあるが、フィルタは符号器より先を走るので実機で5秒ずれた。
 *
 * **消すための別の種別も使わない。** 全部透明な絵を重ねれば消えるので、
 * 空かどうかを見分ける必要そのものが無い (上の説明)
 */
export function frame(caption: Caption): { kind: number; pts: bigint; data: Uint8Array } {
    const out = new Uint8Array(8 + caption.data.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, 0);
    view.setUint16(2, 0);
    view.setUint16(4, CANVAS.width);
    view.setUint16(6, CANVAS.height);
    out.set(caption.data, 8);
    return { kind: CHANNEL.subtitle, pts: 0n, data: out };
}

/** テスト用。掴んだままのものを残さない */
export function stopAllCaptions(): void {
    for (const captions of [...running.values()]) captions.stop();
}
