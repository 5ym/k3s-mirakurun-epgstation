/**
 * ライブ視聴の受け側。**WebSocket で受けて MSE へ流す。**
 *
 * MSE は取ってこない。`appendBuffer()` に渡すバイト列をどこから持ってくるかは
 * こちら次第で、denpa は WebSocket から受ける ([stream.md](../../docs/stream.md) §5.3)。
 * 同じ1本に字幕もデータ放送も相乗りする作りなので、種別で振り分ける。
 */

import type { AudioTrack } from '$lib/arib';
import {
    type CaptionTrack,
    CHANNEL,
    type Command,
    LAST_COOKIE,
    type LiveCodec,
    type Notice,
    SOCKET_PATH,
    type Tuned,
} from '$lib/live';
import { type Cue, captionAt, currentCue, insertCue, trimCues } from '$lib/ts/captions';
import { FLOOR, nextTarget, pacing } from '$lib/ts/pacing';

export type LiveState = 'idle' | 'connecting' | 'playing' | 'error';

/**
 * 遅れて見られる長さ (秒)。**止めている間も受け取り続けるので、上限が要る。**
 *
 * ブラウザが抱えられる量には上限があり、超えると `appendBuffer` が落ちる。
 * 5分あれば、電話に出て戻ってくるくらいは追いつける。
 */
const KEEP = 300;
/**
 * 抱えてよい量 (バイト)。**時間だけで切ると、太い絵で溢れる。**
 *
 * 5分は「毎秒 3Mbit なら 110MB」のつもりで決めた値だった。ところが焼き方は
 * 選べるようになっていて (`LiveCodec`)、H.264 は絵を優先するので実測 35.9Mbit/s
 * ある — そのまま5分持つと **1.3GB** で、ブラウザの上限 (数百MB) を軽く超える。
 * 超えると `appendBuffer` が `QuotaExceededError` で落ち、**そこから絵が出ない**。
 *
 * なので**時間とバイト数の小さいほう**で切る。太ければ戻れる幅が縮むだけで、
 * 映らなくなるよりはるかにいい
 */
const BUDGET = 120 * 1024 * 1024;
/** 戻れる幅の下限 (秒)。ここまで縮めても足りないなら、そもそも抱えられない */
const KEEP_LEAST = 20;
/** 貯める量を決め直す間隔 (ms)。塊は毎秒20個来るので、そのたびには回さない */
const SETTLE_EVERY = 5_000;
/**
 * 選局や跳んだ直後、詰まりを数えない間 (ms)。
 *
 * **自分で起こした詰まりで貯める量を増やさない。** 器を作り直せば必ず
 * `waiting` が上がるし、跳べば読み込み直しになる。宅外で本当に届かない
 * のとは別ものなので、混ぜると遅延が伸びたまま戻らない
 */
const GRACE = 3_000;
/**
 * 前の絵を貼っておく上限 (ms)。**次が出なくても、いつかは剥がす。**
 *
 * 貼りっぱなしにすると、選局に失敗したときに「前のチャンネルが止まっている」
 * 画面が残る。壊れているのに動いて見えるのがいちばん悪い
 */
const HOLD_MOST = 6_000;

/**
 * 見ている局を覚える。**置き場は cookie 1つ。**
 *
 * **読むのはサーバ** (`live/+page.server.ts`)。次に開いたとき、画面が繋いで
 * くるのを待たずに焼きはじめるため (`server/live.ts` の `warm`)。localStorage
 * にも持っていた頃があるが、**二重に持つと決め方がずれる** — 先に焼いたものが
 * 使われず、画面は別の局を開く、という形で静かに壊れる。
 *
 * **音声も覚える。** 番組が変われば構成も変わる (二カ国語の映画が終われば
 * ステレオに戻る) が、サーバは無いものを頼まれたら先頭に落とす
 * (`arib.pickTrack`) ので、古い合言葉が残っていても困らない
 */
function remember(target: Tuned): void {
    const value = encodeURIComponent(JSON.stringify(target));
    document.cookie = `${LAST_COOKIE}=${value}; path=/live; max-age=31536000; samesite=lax`;
}

export function livePlayer() {
    let state = $state<LiveState>('idle');
    let message = $state('');
    let tuned = $state<Tuned | null>(null);
    /** 音を止められているか。**自動再生を断られたときだけ立つ** */
    let silenced = $state(false);
    /**
     * 放送からどれだけ遅れているか (秒)。**受け取った最後の絵と、いま映して
     * いる絵の差。** ここが遅延の大半で、焼き方より効く。出しているのは、
     * 詰まりが増えていないかを見ながら詰めていくため
     */
    let delay = $state<number | null>(null);
    /** 止めているか。**押して止めた間も受け取り続ける** */
    let paused = $state(false);
    /** 放送の今に張り付いているか。離れていれば「ライブへ」を出す */
    let live = $state(true);
    /**
     * 追っかけ再生か。**わざと遅れて見ている状態。**
     *
     * 止めたときと、帯を後ろへ戻したときに立つ。立っている間は放送の今を
     * 追いかけず (跳ばない)、選ばれた速さで進む。追いついたら自分で下りる
     */
    let chasing = $state(false);
    /** 追っかけ中の速さ。ライブに戻れば 1 に戻す */
    let speed = $state(1);
    /** どれだけ貯めているか (秒)。詰まると伸び、無事が続くと縮む */
    let target = $state(FLOOR);
    /**
     * どこまで戻れて、いまどこに居るか。**操作の帯を描くのに使う。**
     *
     * 0.1秒刻みで入れ直す。塊は毎秒20個来るので、そのたびに動かすと
     * 画面を無駄に描き直すことになる
     */
    let oldest = $state(0);
    let newest = $state(0);
    let position = $state(0);
    /** 選べる音声。1つしか無ければ画面は切り替えを出さない */
    let audios = $state<AudioTrack[]>([]);
    /** いま鳴らしている音声 (`AudioTrack.id`) */
    let audio = $state('');
    /** いま焼いてもらっている形。**サーバが返してきたものを持つ** */
    let codec = $state<LiveCodec>('h264');
    /**
     * 字幕を出すまで待たせる量 (秒)。**サーバが決めて寄越す。**
     *
     * **H.264 は 0** — 字幕が届いたときには、その字幕が属する映像も届いている。
     * AV1 だけ符号器が溜め込むぶん待たせる (`server/live.ts` の `captionLead`)。
     * ここに置いてあるのは `tuned` が届く前の繋ぎ
     */
    let lead = 0;
    /**
     * 断り書き。**失敗ではないが、頼まれたとおりにできなかったとき。**
     *
     * いまのところ「AV1 を出せない端末なので H.264 に戻した」の1つだけ。
     * `message` と分けてあるのは、あちらが選局のたびに消えるため — 戻した理由は
     * 戻した先が映り始めても残っていないと、なぜ変わったのか分からない
     */
    let warning = $state('');
    /** 前の絵を貼っているか。**次の絵が出るまでの黒を埋める** */
    let holding = $state(false);
    /** 字幕を出すか。**押して切り替えられる** (テレビの字幕ボタン) */
    let captions = $state(true);
    /**
     * 選べる字幕。**1枚も届いていなくても分かる。**
     *
     * 届いてから切り替えを出していた頃は、**間隔の空く番組を開くとボタンが
     * 出なかった** (実機の「みんなの手話」。番組表には [字] と出ているのに)。
     * 放送が字幕を持っているかどうかはサーバが入口で読んでいる
     */
    let captionTracks = $state<CaptionTrack[]>([]);
    /** いま出している字幕 (`CaptionTrack.index`) */
    let captionTrack = $state(0);

    let socket: WebSocket | null = null;
    let source: MediaSource | null = null;
    let buffer: SourceBuffer | null = null;
    /** いま鳴らしている器。押して音を出すのに要る */
    let element: HTMLVideoElement | null = null;
    /** 前の絵の写し先。画面から預かる */
    let still: HTMLCanvasElement | null = null;
    /** 字幕を重ねる先。画面から預かる */
    let overlay: HTMLCanvasElement | null = null;
    /** 貼りっぱなしを避けるための目覚まし */
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * 待たせている字幕。**時刻の順に並べておく** ([ts/captions.ts](./ts/captions.ts))。
     *
     * H.264 は届いた時点の再生位置に置くので、ほぼその場で出る。AV1 だけ
     * 符号器が溜め込むぶん待たせるので、再生位置が追いつくまで持っておく
     */
    let cues: Cue[] = [];
    /** いま重ねている1枚。同じものを描き直さない */
    let shown: Cue | null = null;
    /**
     * 選局の代。**絵にし終わる頃には局が変わっていることがある。**
     *
     * PNG を `ImageBitmap` にするのは非同期なので、その間に選び直されると
     * 前の局の字幕が新しい局の上に出る。番号が変わっていたら捨てる
     */
    let generation = 0;
    /** もう再生を始めたか。始めるまでは貯める */
    let running = false;
    /** 最後に詰まった時刻。無事が続いたかを見る */
    let lastStall = 0;
    /** 前回 `nextTarget` を回してから詰まったか */
    let stalled = false;
    /** 最後に `nextTarget` を回した時刻 */
    let lastSettled = 0;
    /**
     * この時刻まで、詰まっても数えない。**自分で起こした詰まりを数えないため。**
     *
     * 選局した直後と、跳んだ直後は必ず `waiting` が上がる。数えていた頃は
     * それだけで貯める量が増え、遅延が伸びたまま戻らなかった — **伸びるのは
     * 一度に 0.6 秒、縮むのは 0.15 秒ずつ**なので (`pacing.ts`)、1回増えると
     * 何十秒も残る。
     */
    let quiet = 0;
    /**
     * 追加待ちの列。**`appendBuffer` は1つずつしか受け付けない** —
     * 前のが終わる前に呼ぶと `InvalidStateError` で止まる
     */
    const pending: Uint8Array[] = [];
    /** 受け取った映像の量と、数えはじめた時刻。**戻れる幅を決めるのに使う** */
    let received = 0;
    let receivedFrom = 0;

    /**
     * 前の絵を写して、次が出るまで貼っておく。**切り替えの間の黒を埋める。**
     *
     * 切り替えにかかる時間は、ほとんどが**こちらの都合では動かないもの**
     * ([stream.md](../../docs/stream.md) §4 に実測の内訳)。復調器のロック 0.32秒、
     * スクランブル解除が ECM を待つ 0.24秒、ffmpeg の立ち上がり 0.53秒、
     * 放送の I フレーム待ち 0〜0.50秒。
     * **待ち時間そのものは変わらないが、黒い画面を見せずに済む。**
     *
     * 器を作り直すと `<video>` は何も映さなくなるので、その前に1枚だけ
     * canvas へ写し取って上に重ねる。動画ではなく静止画なので、止まって見える —
     * それは正しい。実際に止まっている
     */
    function freeze(): void {
        if (element === null || still === null) return;
        // まだ1枚も出ていない (初めて開いたとき)。写すものが無い
        if (element.readyState < 2 || element.videoWidth === 0) return;
        const ctx = still.getContext('2d');
        if (ctx === null) return;
        still.width = element.videoWidth;
        still.height = element.videoHeight;
        ctx.drawImage(element, 0, 0, still.width, still.height);
        holding = true;
        if (holdTimer !== null) clearTimeout(holdTimer);
        holdTimer = setTimeout(thaw, HOLD_MOST);
    }

    /** 剥がす。**次の絵が実際に出てから** (`onFrame`) */
    function thaw(): void {
        if (holdTimer !== null) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }
        if (holding) holding = false;
    }

    /**
     * 次の絵が画面に出たら呼ぶ。
     *
     * `play()` が返っただけでは**まだ何も映っていない**ので、そこで剥がすと
     * 一瞬黒くなる。`requestVideoFrameCallback` は「1枚映した」ところで来る。
     * 持っていないブラウザでは `timeupdate` で代える (1枚ぶん遅いが実害は無い)
     */
    function onFrame(video: HTMLVideoElement, done: () => void): void {
        const request = (video as HTMLVideoElement & { requestVideoFrameCallback?(cb: () => void): number })
            .requestVideoFrameCallback;
        if (typeof request === 'function') request.call(video, done);
        else video.addEventListener('timeupdate', done, { once: true });
    }

    /** 字幕を貼り直し続けている映像。**1つにつき1本** */
    let following: HTMLVideoElement | null = null;

    /**
     * 字幕を、**映した1枚ごとに**貼り直す。
     *
     * 貼り直しを `pace` に相乗りさせていた頃は、**塊が届いたときにしか
     * 貼り直していなかった**。塊は 0.05秒ごとなので、ずれるのは**遅れる方向
     * だけ** — 実機で測ると、狙った 507ms に対して実際に出るのは平均 522ms・
     * 最大 560ms だった。字幕は 1〜2秒で入れ替わるので、これが「次の表示が
     * 気持ち遅い」として出る。
     *
     * `requestVideoFrameCallback` は**映した1枚ごと**に来るので、貼り直す時刻が
     * 見えている絵と揃う。持っていないブラウザは画面の書き換えごとに代える
     * (60Hz なら 16ms)。
     *
     * **止めて見ている間は来ない。** 片付け (`sweep`) は `pace` に置いたままに
     * してあるので、待たせているぶんが溜まりっぱなしにはならない。
     * `paint` は出すものが変わっていなければその場で戻るので、空回りは安い
     */
    function follow(video: HTMLVideoElement): void {
        if (following === video) return;
        following = video;
        const again = () => {
            // 別の映像に移ったら、こちらは畳む
            if (following !== video) return;
            paint(video.currentTime);
            step();
        };
        const step = () => {
            const request = (
                video as HTMLVideoElement & { requestVideoFrameCallback?(cb: () => void): number }
            ).requestVideoFrameCallback;
            if (typeof request === 'function') request.call(video, again);
            else requestAnimationFrame(again);
        };
        step();
    }

    /**
     * 字幕を重ねる。**再生位置に合う1枚だけ描く。**
     *
     * 字幕は次が来るまで出しっぱなしなので、選ぶのは「時刻が再生位置を
     * 追い越していない中の、最後の1つ」([ts/captions.ts](./ts/captions.ts))。
     * 跳んだ直後もこれで追いつく。
     *
     * **絵は画面まるごとの大きさで来る** (1920x1080)。canvas を映像と同じ枠に
     * 敷いて、そこへ引き伸ばして描くので、位置合わせはブラウザ任せでよい
     */
    function paint(at: number): boolean {
        if (overlay === null) return false;
        // 原点が分かるまでは置き場所が決まらない。出すと合っていない時刻に出る
        const next = captions ? currentCue(cues, at) : null;
        if (next === shown) return false;
        shown = next;

        const ctx = overlay.getContext('2d');
        if (ctx === null) return true;
        const bitmap = next?.bitmap ?? null;
        if (bitmap === null) {
            ctx.clearRect(0, 0, overlay.width, overlay.height);
            return true;
        }
        if (overlay.width !== bitmap.width || overlay.height !== bitmap.height) {
            overlay.width = bitmap.width;
            overlay.height = bitmap.height;
        }
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        ctx.drawImage(bitmap, 0, 0);
        return true;
    }

    /** 待たせているぶんを片付ける。**いま出している1枚は残す** (出しっぱなしのため) */
    function sweep(at: number): void {
        const kept = trimCues(cues, at);
        if (kept.length === cues.length) return;
        for (const cue of cues) {
            if (kept.includes(cue) || cue === shown) continue;
            cue.bitmap?.close();
        }
        cues = kept;
    }

    function drain(): void {
        if (buffer === null || buffer.updating || pending.length === 0) return;
        const next = pending.shift();
        if (next === undefined) return;
        try {
            buffer.appendBuffer(next as BufferSource);
        } catch {
            // 追いつけなくなった。次の init から入り直す
            pending.length = 0;
        }
    }

    /**
     * 再生位置を面倒みる。**届いた端でそのまま出すと、絶えず止まる。**
     *
     * 少し貯めてから始め、離れたら速めて詰める ([pacing.ts](./ts/pacing.ts))。
     * 別のタブへ行って戻ってきたときだけ跳ぶ — 跳ぶと音が切れるので、
     * 常用するとそれ自体が「かくつき」になる。
     */
    function pace(video: HTMLVideoElement): void {
        if (buffer === null || buffer.updating || buffer.buffered.length === 0) return;
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        const behind = end - video.currentTime;
        /*
         * **0.1秒刻みにする。** 塊は毎秒20個届くので、そのたびに書き換えると
         * 画面を無駄に描き直すことになる
         */
        const rounded = running ? Math.round(behind * 10) / 10 : null;
        if (rounded !== delay) delay = rounded;
        // 放送の今に張り付いているか。少しの揺れでは離れたことにしない
        const atLive = behind <= target + 1.5;
        if (atLive !== live) live = atLive;

        const tenth = (value: number) => Math.round(value * 10) / 10;
        if (tenth(buffer.buffered.start(0)) !== oldest) oldest = tenth(buffer.buffered.start(0));
        if (tenth(end) !== newest) newest = tenth(end);
        if (tenth(video.currentTime) !== position) position = tenth(video.currentTime);

        /*
         * **片付けは毎回する。** 待たせているぶんは先の時刻に積まれるので、
         * 止めて見ている間は出す番が来ない。変わったときだけ片付けていた頃は、
         * そのぶんが際限なく溜まった (1枚 1920x1080 なので、止めっぱなしだと効く)。
         *
         * 貼り直しもここでする。**普段効いているのは `follow` のほう**だが、
         * 止めて見ている間は映した1枚が来ないので、こちらが要る
         */
        paint(video.currentTime);
        sweep(video.currentTime);

        trim(end);
        settle();

        /*
         * **押して止めている間は動かさない。** 受け取りは続けているので溜まって
         * いくが、そこへ跳ばせると「止めた所から見る」ができなくなる。
         * 追いかけ直すのは「ライブへ」を押されたとき (`goLive`)
         */
        if (paused) return;

        const next = pacing({
            start: buffer.buffered.start(0),
            end,
            at: video.currentTime,
            playing: running,
            target,
            chasing,
            speed,
        });

        /*
         * **追いついたらライブに戻す。** 押してもらう必要は無い — 追いついた
         * ところで選んだ速さのまま進むと放送を追い越し、溜まりを使い切って止まる
         */
        if (next.caught) {
            chasing = false;
            speed = 1;
        }
        if (next.seek !== null) {
            video.currentTime = next.seek;
            quiet = Date.now() + GRACE;
        }
        if (next.rate !== null) video.playbackRate = next.rate;
        if (next.play && !running) {
            running = true;
            state = 'playing';
            void play(video);
            // 1枚映ってから前の絵を剥がす。ここで剥がすと一瞬黒くなる
            onFrame(video, thaw);
        }
    }

    /**
     * 溜まりすぎを刈る。**止めている間も受け取り続けるので、放っておくと際限なく太る。**
     *
     * ブラウザが抱えられる量には上限があり、超えると `appendBuffer` が
     * `QuotaExceededError` で落ちる。落ちるとそこから絵が出なくなるので、
     * 遅れて見られる長さに上限を設けて、古いほうから捨てる。
     */
    /**
     * どれだけ戻れるか (秒)。**太い絵ほど短くなる。**
     *
     * 受け取っている速さから、`BUDGET` に収まる長さを出す。まだ測れていない
     * 間は今までどおり 5 分。
     */
    function keepFor(): number {
        const seconds = (Date.now() - receivedFrom) / 1000;
        if (receivedFrom === 0 || seconds < 2 || received === 0) return KEEP;
        const perSecond = received / seconds;
        return Math.max(KEEP_LEAST, Math.min(KEEP, BUDGET / perSecond));
    }

    function trim(end: number): void {
        if (buffer === null || buffer.updating || buffer.buffered.length === 0) return;
        const cut = end - keepFor();
        if (buffer.buffered.start(0) >= cut) return;
        try {
            buffer.remove(0, cut);
        } catch {
            // 追加中だった。次の機会に
        }
    }

    /** 貯める量を決め直す。**止まったら伸ばし、無事が続いたら縮める** */
    function settle(): void {
        const now = Date.now();
        if (!stalled && now - lastSettled < SETTLE_EVERY) return;
        const settledFor = (now - lastStall) / 1000;
        const next = nextTarget(target, stalled, settledFor);
        stalled = false;
        lastSettled = now;
        if (next !== target) target = next;
    }

    /**
     * 鳴らす。**断られたら、音を諦めて絵だけ出す。**
     *
     * 前回のチャンネルで勝手に始める作りなので、開いた直後は「押した」ことに
     * なっていない。その状態で音ありの再生を求めると、ブラウザは丸ごと断る —
     * 黙って諦めると、絵も出ないまま黒い画面が残る。
     */
    async function play(video: HTMLVideoElement): Promise<void> {
        video.muted = silenced;
        try {
            await video.play();
        } catch {
            video.muted = true;
            silenced = true;
            try {
                await video.play();
            } catch {
                // それでも駄目。備え付けの再生ボタンを押してもらう
            }
        }
    }

    /** 音を出す。**押されて呼ばれる** — ここまで来ればブラウザは断らない */
    function unmute(): void {
        silenced = false;
        if (element === null) return;
        element.muted = false;
        void element.play().catch(() => {
            /* 押したのに断られることはない */
        });
    }

    /** 音を止める。備え付けの操作を出さないので、こちらで用意する */
    function mute(): void {
        silenced = true;
        if (element !== null) element.muted = true;
    }

    /**
     * 止める・再開する。**止めても受け取りは続く。**
     *
     * 止めた時点で追っかけに入る。再開しても放送の今へは跳ばない
     * (`pacing` が `chasing` の間は跳ばない)。放送に戻りたいときは `goLive`。
     *
     * **印を立てるのは止めるときだけで足りる。** 立てていなかった頃は、
     * 8秒より長く止めて再開すると `pacing` が勝手に放送の今へ跳んでいた —
     * 「止めた所から見られる」と謳っておきながら、実際には戻れなかった
     */
    function toggle(): void {
        if (element === null) return;
        if (paused) {
            paused = false;
            void element.play().catch(() => {
                /* 押されて呼ばれるので断られない */
            });
        } else {
            paused = true;
            chasing = true;
            element.pause();
        }
    }

    /** 放送の今へ追いつく。**追っかけをやめて、見ていたぶんを飛ばす** */
    function goLive(): void {
        if (element === null || buffer === null || buffer.buffered.length === 0) return;
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        element.currentTime = Math.max(buffer.buffered.start(0), end - target);
        chasing = false;
        speed = 1;
        element.playbackRate = 1;
        quiet = Date.now() + GRACE;
        if (paused) toggle();
    }

    /**
     * 字幕を選び直す。**言語が複数ある放送はたまにある。**
     *
     * 音声と違って**映像は焼き直しにならない** — 字幕は別の ffmpeg なので、
     * そちらだけ入れ替わる。待たせているぶんは捨てる (別の言語なので使えない)
     */
    function setCaptionTrack(index: number): void {
        if (tuned === null || index === captionTrack) return;
        captionTrack = index;
        clearCaptions();
        const command: Command = { type: 'tune', ...tuned, caption: index };
        if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
    }

    /**
     * 追っかけの速さを選ぶ。**追っかけている間だけ効く。**
     *
     * ライブに張り付いているときに速められては困る (放送より先は無い) ので、
     * ここで選べるのは遅れて見ているときだけ。追いついたら 1 に戻す (`pace`)
     */
    function setSpeed(next: number): void {
        if (!chasing) return;
        speed = next;
        if (element !== null) element.playbackRate = next;
    }

    /**
     * 持っている範囲の中で移る。帯を押されたとき。
     *
     * **後ろへ戻したら追っかけに入る。** 入れないと `pacing` が「大きく離れた」と
     * 見て放送の今へ跳ね返すので、戻した先が1秒も映らない
     */
    function seek(to: number): void {
        if (element === null || buffer === null || buffer.buffered.length === 0) return;
        const start = buffer.buffered.start(0);
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        const at = Math.min(end, Math.max(start, to));
        element.currentTime = at;
        // 端の近くへ戻しただけならライブのまま。少しの操作で追っかけにしない
        if (end - at > target + 1.5) chasing = true;
        quiet = Date.now() + GRACE;
    }

    /**
     * 再生の状態だけ初期に戻す。**繋ぎ直さない。**
     *
     * 音声を選び直したときはサーバが焼き直すので、器は作り直すが繋ぎ直す
     * 必要は無い (`setAudio`)。器を作り直す `start` からも通る
     */
    function clear(): void {
        buffer = null;
        source = null;
        running = false;
        delay = null;
        paused = false;
        live = true;
        // 局や音声を選び直したら、追っかけていた場所はもう無い
        chasing = false;
        speed = 1;
        oldest = 0;
        newest = 0;
        position = 0;
        pending.length = 0;
    }

    /** 繋ぎも含めて畳む。**画面を離れるときと、繋ぎ直すとき** */
    function reset(): void {
        socket?.close();
        socket = null;
        forget(false);
    }

    /**
     * 受け取ったものを忘れる。**繋ぎはそのまま。**
     *
     * @param keepCaptions 字幕はそのままにするか。**音声を選び直したときだけ true** —
     *   サーバ側の字幕は局で決まるので回り続けており (`captions.ts`)、捨てると
     *   次の字幕まで何も出なくなる。映像の時刻も変わらないので待たせているぶんは使える
     */
    function forget(keepCaptions: boolean): void {
        if (!keepCaptions) {
            clearCaptions();
            // 局が変われば、持っている字幕も変わる (字幕そのものが無い局もある)
            captionTracks = [];
            captionTrack = 0;
        }
        clear();
    }

    /** 待たせている字幕を捨てる。**局を変えるときだけ** (`forget` の説明) */
    function clearCaptions(): void {
        generation++;
        for (const cue of cues) cue.bitmap?.close();
        cues = [];
        shown = null;
        const ctx = overlay?.getContext('2d');
        if (ctx !== null && ctx !== undefined && overlay !== null) {
            ctx.clearRect(0, 0, overlay.width, overlay.height);
        }
    }

    /** 画面を離れる。**貼った絵も剥がす** — 戻ってきたときに残っていては困る */
    function stop(): void {
        reset();
        thaw();
    }

    /** 出せなかったことにする。**貼った絵は剥がす** — 動いて見えるほうが悪い */
    function fail(text: string): void {
        state = 'error';
        message = text;
        thaw();
    }

    /**
     * 音声を選び直す。**繋ぎ直さずに頼み直す。**
     *
     * サーバは音声ごとに別の ffmpeg を回す (`live.ts` の目印) ので、選び直すと
     * 器から作り直しになる。チャンネルは変わらないのでチューナーは掴んだままで、
     * かかるのは焼き始めのぶんだけ。**前の絵は貼っておく**ので、絵は止まるが
     * 黒くはならない
     */
    function setAudio(id: string): void {
        if (tuned === null || element === null || id === audio) return;
        // 局は変わらないので、待たせている字幕はそのまま使える
        void tune(element, { ...tuned, audio: id }, true);
    }

    /**
     * 焼き方を選び直す。**音声とまったく同じ扱い。**
     *
     * サーバは焼き方ごとに別の ffmpeg を回す (`server/live.ts` の目印) ので、
     * 器から作り直しになる。チャンネルは変わらないのでチューナーは掴んだままで、
     * かかるのは焼き始めのぶんだけ。**前の絵は貼っておく**ので、絵は止まるが
     * 黒くはならない。
     *
     * **出るかどうかは端末次第。** AV1 を受け取れないブラウザもあるので、
     * 器を作るところで断られたら、そう言って H.264 に戻せるようにする (`start`)
     */
    function setCodec(next: LiveCodec): void {
        // 選び直したなら、前の断り書きは用済み
        warning = '';
        swapCodec(next);
    }

    /** 中身。**断り書きを消さない**ので、戻すときにも使える */
    function swapCodec(next: LiveCodec): void {
        if (tuned === null || element === null || next === codec) return;
        // 局は変わらないので、待たせている字幕はそのまま使える
        void tune(element, { ...tuned, codec: next }, true);
    }

    /**
     * 重ねるものの置き場を預かる。**画面が組み上がってから1回だけ。**
     *
     * @param frozen 切り替えの間、前の絵を貼っておく先 (`freeze`)
     * @param subtitles 字幕を重ねる先 (`paint`)
     */
    function attach(frozen: HTMLCanvasElement, subtitles: HTMLCanvasElement): void {
        still = frozen;
        overlay = subtitles;
    }

    /**
     * 選局する。**繋がっていれば繋ぎ直さない。**
     *
     * @param keepCaptions 待たせている字幕を残すか。**音声の選び直しだけ true**
     *   (`forget` の説明)
     */
    async function tune(video: HTMLVideoElement, target: Tuned, keepCaptions = false): Promise<void> {
        element = video;
        // 字幕は映した1枚ごとに貼り直す (`follow`)。2度目からは何もしない
        follow(video);
        // 次の絵が出るまで前の絵を貼る。**閉じる前に写す** (閉じると何も映らなくなる)
        freeze();
        /*
         * **繋がっていれば繋ぎ直さない。**
         *
         * 取り決めは1本の WebSocket に何度でも `tune` を送れる形になっていて
         * (`server/live.ts` の `attend`)、音声の選び直しは前からそうしていた。
         * 局を変えるときだけ張り直していたのは**ただの取りこぼし**で、実測で
         * 札を取り直すのに 50ms、握手に 50ms 掛かっていた
         */
        const open = socket !== null && socket.readyState === WebSocket.OPEN;
        if (open) forget(keepCaptions);
        else reset();

        state = 'connecting';
        message = '';
        tuned = target;
        audio = target.audio ?? '';
        codec = target.codec ?? 'h264';
        quiet = Date.now() + GRACE;
        remember(target);

        if (open) {
            socket?.send(JSON.stringify({ type: 'tune', ...target } satisfies Command));
            return;
        }

        /*
         * **札を先に取る。** ブラウザは WebSocket の握手に `Authorization` を
         * 付けてくれないので、認証を通れることをここで示す (`tickets.ts`)
         */
        let ticket: string;
        try {
            const res = await fetch('/api/live/ticket', { method: 'POST' });
            if (!res.ok) throw new Error(String(res.status));
            ticket = ((await res.json()) as { ticket: string }).ticket;
        } catch {
            fail('繋ぐ許可を取れませんでした');
            return;
        }

        const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${scheme}://${location.host}${SOCKET_PATH}?ticket=${ticket}`);
        ws.binaryType = 'arraybuffer';
        socket = ws;

        ws.onopen = () => {
            /*
             * **`Tuned` をそのまま渡す。** 中身を書き写していた頃は、
             * `Tuned` に足したものをここへ足し忘れると**繋ぎ直したときだけ
             * 抜ける**という出方をした (焼き方を選んで開き直すと H.264 に
             * 戻っていた。繋いだままの選び直しでは効くので、余計に分かりにくい)
             */
            ws.send(JSON.stringify({ type: 'tune', ...target } satisfies Command));
        };

        ws.onerror = () => {
            if (state !== 'playing') fail('繋がりませんでした');
        };

        ws.onclose = () => {
            if (socket === ws && state !== 'error') state = 'idle';
        };

        ws.onmessage = (event) => {
            const data = event.data as ArrayBuffer;
            const kind = new DataView(data).getUint8(0);
            const body = new Uint8Array(data, 9);

            if (kind === CHANNEL.control) {
                const notice = JSON.parse(new TextDecoder().decode(body)) as Notice;
                if (notice.type === 'error') {
                    fail(notice.message);
                } else if (notice.type === 'captions') {
                    /*
                     * **1枚も届いていなくても、あることは分かる。** 届いてから
                     * 切り替えを出していた頃は、間隔の空く番組でボタンが出なかった
                     */
                    captionTracks = notice.tracks;
                    captionTrack = notice.track;
                } else if (notice.type === 'tuned') {
                    /*
                     * **選べる音声はここで初めて分かる。** どれが選べるかは
                     * いま流れている番組次第なので、局の一覧からは決められない
                     */
                    audios = notice.audios;
                    audio = notice.audio;
                    codec = notice.codec;
                    lead = notice.lead;
                    start(video, notice.codecs, notice.codec);
                }
                return;
            }

            if (kind === CHANNEL.videoInit) {
                /*
                 * **init が来たら作り直す。** チャンネルを変えると器も変わるので、
                 * 前の SourceBuffer に足すと中身が混ざって再生が止まる
                 */
                pending.length = 0;
                if (buffer !== null && source?.readyState === 'open') {
                    try {
                        buffer.abort();
                    } catch {
                        // 追加中でなければ投げる。気にしない
                    }
                }
            }
            if (kind === CHANNEL.videoInit || kind === CHANNEL.videoMedia) {
                // 戻れる幅を決めるのに、どれだけ来ているかを数える (`keepFor`)
                if (receivedFrom === 0) receivedFrom = Date.now();
                received += body.byteLength;
                pending.push(body);
                drain();
                return;
            }

            /*
             * **字幕。** 中身の頭は `[2:x][2:y][2:w][2:h][PNG...]`
             * ([stream.md](../../docs/stream.md) §5.3)。
             *
             * 置き場所 (x,y,w,h) はいま使わない — 画面まるごとが来るため。
             * **あとで切り抜くようにしてもここを変えずに済む**ように読んでおく
             */
            if (kind === CHANNEL.subtitle || kind === CHANNEL.subtitleClear) {
                if (element === null) return;
                /*
                 * **いま映っている絵に合わせる** ([ts/captions.ts](./ts/captions.ts)
                 * の `captionAt`)。待たせる量はサーバが決めて寄越す (`lead`) が、
                 * H.264 は 0 なので実質「届いたら出す」。
                 *
                 * 「いちばん新しく届いている映像」(`buffered.end`) に置いていた頃は、
                 * **貯めているぶんだけ遅れて**いた。絶対の時刻で合わせられない理由は
                 * [stream.md](../../docs/stream.md) §5.4
                 */
                const at = captionAt(element.currentTime, lead);

                if (kind === CHANNEL.subtitleClear) {
                    cues = insertCue(cues, { at, bitmap: null });
                    return;
                }
                /*
                 * **絵にするのは非同期。** 待っている間に選局が変わることが
                 * あるので、そのときは捨てる (`generation`)
                 */
                const mine = generation;
                const png = new Uint8Array(data, 9 + 8);
                void createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }))
                    .then((bitmap) => {
                        if (mine !== generation) {
                            bitmap.close();
                            return;
                        }
                        cues = insertCue(cues, { at, bitmap });
                    })
                    .catch(() => {
                        /* 壊れた1枚。次が来る */
                    });
            }
        };
    }

    /**
     * 器を用意する。`codecs` はサーバが焼き方から決めて送ってくる。
     *
     * **受け取れない形なら、H.264 へ戻す。** AV1 を選べるようにしてある以上、
     * 出ない端末で選ばれることは普通に起きる。そこで諦めると**黒いまま**に
     * なるので、確実に出るほうへ落として、そう言う
     */
    function start(video: HTMLVideoElement, codecs: string, baked: LiveCodec): void {
        if (!('MediaSource' in globalThis) || !MediaSource.isTypeSupported(codecs)) {
            if (baked !== 'h264') {
                warning = 'この端末では AV1 を再生できないので、H.264 に戻しました';
                swapCodec('h264');
                return;
            }
            fail('この端末では再生できない形式です');
            return;
        }
        /*
         * **前の器の名残を落とす。** 音声を選び直したときは繋ぎ直さないので
         * (`setAudio`)、ここを通っても `reset` は挟まらない。古い SourceBuffer に
         * 足しに行くと中身が混ざって止まる
         */
        clear();
        // 焼き方が変われば太さも変わる。数え直す
        received = 0;
        receivedFrom = 0;
        const media = new MediaSource();
        source = media;
        video.src = URL.createObjectURL(media);
        media.addEventListener(
            'sourceopen',
            () => {
                URL.revokeObjectURL(video.src);
                /*
                 * **終わりが無いと言っておく。**
                 *
                 * 何も言わないと、MediaSource の尺は「いま持っている中でいちばん
                 * 後ろ」になる。0.05秒ごとに中身が届くたびに尺が伸びるので、
                 * 備え付けの再生位置は右端まで行っては少し左へ戻る、を繰り返す。
                 * 放送に終わりは無いので、そう言うほうが正しい
                 */
                media.duration = Number.POSITIVE_INFINITY;
                buffer = media.addSourceBuffer(codecs);
                /*
                 * **並べ直させない** (`sequence` にしない)。焼いたものの時刻を
                 * そのまま使う。並べ直しは「届いた順に詰める」動きなので、
                 * 1つでも取りこぼすと以降ずっと映像と音声がずれる
                 */
                buffer.mode = 'segments';
                buffer.addEventListener('updateend', () => {
                    drain();
                    pace(video);
                });
                /*
                 * **詰まったことを覚えておく。** 宅内と宅外で必要な貯めの量は
                 * 桁違いに違うのに、どちらから見ているかは分からない。
                 * 実際に止まったかどうかで決める (`nextTarget`)
                 */
                video.addEventListener('waiting', () => {
                    if (paused || Date.now() < quiet) return;
                    stalled = true;
                    lastStall = Date.now();
                });
                drain();
            },
            { once: true },
        );
    }

    return {
        get state() {
            return state;
        },
        get message() {
            return message;
        },
        get tuned() {
            return tuned;
        },
        /** 音を止められているか。押して出してもらう */
        get silenced() {
            return silenced;
        },
        /** 放送からどれだけ遅れているか (秒)。再生していないときは null */
        get delay() {
            return delay;
        },
        /** 押して止めているか */
        get paused() {
            return paused;
        },
        /** 放送の今に張り付いているか */
        get live() {
            return live;
        },
        /** いまどれだけ貯めているか (秒)。詰まると伸びる */
        get buffering() {
            return target;
        },
        /** どこまで戻れるか (いちばん古い時刻) */
        get oldest() {
            return oldest;
        },
        /** 放送の今 (いちばん新しい時刻) */
        get newest() {
            return newest;
        },
        /** いま映している時刻 */
        get position() {
            return position;
        },
        /** 選べる音声。1つしか無ければ切り替えを出さない */
        get audios() {
            return audios;
        },
        /** いま鳴らしている音声 (`AudioTrack.id`) */
        get audio() {
            return audio;
        },
        /** いま焼いてもらっている形 */
        get codec() {
            return codec;
        },
        /** 頼まれたとおりにできなかったときの断り書き。無ければ空 */
        get warning() {
            return warning;
        },
        setCodec,
        /** 前の絵を貼っているか。**切り替えの間の黒を埋めている** */
        get holding() {
            return holding;
        },
        /** 追っかけ再生か。**わざと遅れて見ている** */
        get chasing() {
            return chasing;
        },
        /** 追っかけの速さ。ライブでは常に 1 */
        get speed() {
            return speed;
        },
        setSpeed,
        /** 字幕を出しているか */
        get captions() {
            return captions;
        },
        /** 放送が字幕を持っているか。**1枚も届いていなくても分かる** */
        get hasCaptions() {
            return captionTracks.length > 0;
        },
        /** 選べる字幕。2本以上あれば画面は選び直しを出す */
        get captionTracks() {
            return captionTracks;
        },
        /** いま出している字幕 (`CaptionTrack.index`) */
        get captionTrack() {
            return captionTrack;
        },
        setCaptionTrack,
        /** 字幕の出し入れ。テレビの字幕ボタンと同じ */
        toggleCaptions() {
            captions = !captions;
            if (element !== null) paint(element.currentTime);
        },
        attach,
        seek,
        toggle,
        goLive,
        mute,
        tune,
        unmute,
        setAudio,
        stop,
    };
}
