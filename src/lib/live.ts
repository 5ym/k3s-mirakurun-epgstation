/**
 * ライブ視聴で、サーバとブラウザが取り決めていること。**両側から読む。**
 *
 * 1本の WebSocket に全部を相乗りさせる ([stream.md](../../docs/stream.md) §5.3)。
 *
 *     [1 byte: 種別][8 bytes: PTS (90kHz, BE)][中身...]
 *
 * PTS は元TSの時間軸そのまま (`-copyts`)。**映像とは突き合わせられない** —
 * fMP4 は必ず 0 から始まり、その 0 がどの放送時刻にあたるかは多重化器の都合で
 * 決まる。字幕は時刻ではなく**待たせる量**で合わせている (`Notice.tuned` の
 * `lead`) ので、この値を使うのはデータ放送 (第3段階) からになる。
 */

import type { AudioTrack } from './arib';

/**
 * 焼き方。**見ながら切り替えられる** (`live/+page.svelte`)。
 *
 * - `h264` … 量を捨てて速さを採る (`server/live.ts` の `videoArgs`)。
 *   **どの端末でも出る**ので既定
 * - `av1` … 量を採る。実機 (Xeon E5-2696 v4、HW エンコーダ無し) でも
 *   1080i を解いて60コマ/秒で間に合うが、**放送の今から1秒ぶん離れる** —
 *   SVT-AV1 が溜め込むため (`captionLead` に実測)
 *
 * **どちらがどれだけ小さいかは場面で動く。** どちらも品質を指定して焼いて
 * いる (ビットレートを決めていない) ので、実測も揃わなかった
 * ([stream.md](../../docs/stream.md) §5.1)
 *
 * **生 (MPEG-2 のまま) は入っていない。** ブラウザに MPEG-2 の復号器が無い —
 * 実測で `MediaSource.isTypeSupported('video/mp4; codecs="mp2v.61,mp4a.40.2"')` も
 * `VideoDecoder.isConfigSupported({codec:'mp2v'})` も false ([stream.md](../../docs/stream.md) §6)
 */
export type LiveCodec = 'h264' | 'av1';

/** 選べる焼き方。画面の切り替えに並べる順そのまま */
export const LIVE_CODECS: { id: LiveCodec; label: string; note: string }[] = [
    { id: 'h264', label: 'H.264', note: 'どの端末でも出る' },
    /*
     * **遅れることも書く。** SVT-AV1 は溜め込むので、電波が届いてから塊が出る
     * までが H.264 の数倍かかる (実測は `server/live.ts` の `videoArgs`)。
     * 量は減るが、放送の今からは1秒ぶん離れる
     */
    { id: 'av1', label: 'AV1', note: '軽いが、1秒遅れる。出ない端末もある' },
];

/**
 * 選べる字幕1つぶん。**取り決めなので、ここに置く** — 組み立てるのは
 * サーバ (`server/captions.ts` の `TrackList`) だが、画面も同じ形で読む
 */
export interface CaptionTrack {
    /** その局の中で何本目か。ffmpeg の `0:p:<局>:s:<これ>` に渡す */
    index: number;
    /** ISO 639-2。放送が名乗っていなければ null */
    lang: string | null;
    /** 「字幕 (日本語)」「字幕2 (英語)」 */
    label: string;
}

/** 多重化の種別。番号は stream.md §5.3 の表そのまま */
export const CHANNEL = {
    /** 映像の init セグメント (ftyp + moov) */
    videoInit: 0x00,
    /** 映像の中身 (moof + mdat) */
    videoMedia: 0x01,
    /** 音声の init セグメント。**いまは使わない** (映像と同じ器に入れている) */
    audioInit: 0x10,
    /** 音声の中身。同上 */
    audioMedia: 0x11,
    /** 字幕の絵。第2段階 */
    subtitle: 0x20,
    /**
     * 字幕を消す。第2段階。**いまサーバは送らない。**
     *
     * 消すのは「全部透明な絵」を1枚送れば済む (重ねれば消える)。空かどうかを
     * 見分けるには ffmpeg に別の口で喋らせる必要があり、**その口と絵がずれて
     * 字幕が遅れていた** (`server/captions.ts`)。番号は取り決めとして残す —
     * 画面まるごとではなく切り抜きを送るようにしたら、また要る
     */
    subtitleClear: 0x21,
    /** データ放送。第3段階 */
    data: 0x30,
    /** 制御。**ここだけ双方向**で、中身は JSON */
    control: 0x40,
} as const;

/**
 * サーバ→ブラウザの知らせ。`control` に JSON で載る。
 *
 * **選べる音声は、繋いだあとでないと分からない。** どれが選べるかは
 * いま流れている番組次第 (二カ国語の映画が終わればステレオに戻る) なので、
 * 画面が持っている局の一覧からは決められない。選局のたびに現物を送る
 */
export type Notice =
    | {
          type: 'tuned';
          channelType: string;
          channel: string;
          /** MSE に渡す codecs 文字列。焼き方から決まる */
          codecs: string;
          /** いま焼いている形。画面の切り替えがどれを指すか */
          codec: LiveCodec;
          /**
           * 字幕を出すまで待たせる量 (秒)。**焼き方で決まるのでサーバが寄越す。**
           *
           * **H.264 は 0。** 字幕が届いたときには、その字幕が属する映像も
           * もう届いている。AV1 だけは符号器が溜め込むぶん待たせる。
           * 決めているのはコマ数を知っているサーバ側 (`server/live.ts` の
           * `captionLead`)
           */
          lead: number;
          /** いま焼いている音声 (`AudioTrack.id`) */
          audio: string;
          /** 選べる音声。1つしか無ければ画面は切り替えを出さない */
          audios: AudioTrack[];
      }
    | {
          /**
           * 選べる字幕。**1枚も届いていなくても分かる。**
           *
           * 放送が字幕を持っているかどうかは、ffmpeg が入口で読んだ
           * ストリーム一覧に出ている (`captions.ts` の `TrackList`)。届いてから
           * 出していた頃は、**間隔の空く番組を開くと切り替えが出なかった**。
           * 言語が複数ある放送はここが2本以上になる
           */
          type: 'captions';
          tracks: CaptionTrack[];
          /** いま出しているもの (`CaptionTrack.index`) */
          track: number;
      }
    | { type: 'error'; message: string };

/**
 * ブラウザ→サーバの指示。
 *
 * **局まで渡す。** 物理チャンネルだけでは、いま流れている番組が引けない
 * (1本の中に複数の局が乗っている)。番組が引けないと、インタレ解除で
 * コマ数を倍にするかどうかを決められない (国内アニメだけ倍にしない)。
 *
 * **音声もここで頼む。** 選び直しは焼き直しになる (下の説明) ので、
 * 選局と同じ指示に乗せる
 */
export type Command = {
    type: 'tune';
    channelType: string;
    channel: string;
    serviceId: number;
    /**
     * どの音声を出すか (`AudioTrack.id`)。省くと先頭 = 主音声。
     *
     * **選ぶのはサーバ側。** 音声を全部まとめて送って画面で切り替える手もあるが、
     * MSE は1つの器に複数の音声を入れた fMP4 を、ブラウザによっては
     * 切り替えられない (`audioTracks` の実装がまちまち)。焼くときに1本に
     * 決めてしまえば、どのブラウザでも同じように鳴る
     */
    audio?: string;
    /**
     * どの形で焼くか。省くと `h264`。
     *
     * **音声と同じで、選び直すと焼き直しになる** (器から作り直し)。
     * チャンネルは変わらないのでチューナーは掴んだまま
     */
    codec?: LiveCodec;
    /**
     * どの字幕を出すか (`CaptionTrack.index`)。省くと1本目。
     *
     * **言語が複数ある放送はたまにある。** 音声と違い、こちらを選び直しても
     * 映像は焼き直しにならない (字幕は別の ffmpeg なので、そちらだけ入れ替わる)
     */
    caption?: number;
};

/** WebSocket の宛先 */
export const SOCKET_PATH = '/api/live/socket';

/** どの局を、どの音声で開くか。**画面もサーバも同じ形で扱う** */
export interface Tuned {
    channelType: string;
    channel: string;
    /** 局の内部ID (`services.id`)。いま流れている番組からコマ数を決めるのに要る */
    serviceId: number;
    /** どの音声を出すか (`AudioTrack.id`)。省くと主音声 */
    audio?: string;
    /** どの形で焼くか。省くと `h264` */
    codec?: LiveCodec;
}

/**
 * 前回見ていた局を覚えておく cookie。中身は `Tuned` の JSON。
 *
 * **cookie にするのは、サーバにも読めるようにするため。** 画面を組む時点で
 * 「これからどの局を開くか」が分かっていないと、**繋いでくる前に焼きはじめ
 * られない** (`server/live.ts` の `warm`)。
 *
 * **どの局を開くかを決めるのはサーバ側1箇所** (`live/+page.server.ts`)。
 * 画面はそこで決まったものを開くだけなので、localStorage には持たない —
 * 二重に持つと、決め方がずれたときに**先に焼いたものが使われず、画面は
 * 別の局を開く**という形で静かに壊れる。
 *
 * `/live` にだけ付ける。他の画面の要求に毎回ぶら下げるものではない
 */
export const LAST_COOKIE = 'denpa_live_last';
