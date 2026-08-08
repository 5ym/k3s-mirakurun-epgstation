<script lang="ts">
    import { onMount } from 'svelte';
    import { livePlayer } from '$lib/live-player.svelte';
    import { LIVE_CODECS } from '$lib/live';
    import { SPEEDS } from '$lib/ts/pacing';
    import { time } from '$lib/format';
    import type { LiveChannel } from './+page.server';

    let { data } = $props();
    // 局が入れ替わると読み込み直されるので、値ではなく参照で持つ
    const channels = $derived(data.channels as LiveChannel[]);

    const player = livePlayer();
    let video: HTMLVideoElement;
    /** 切り替えの間、前の絵を貼っておく先 (`live-player` の `freeze`) */
    let still: HTMLCanvasElement;
    /** 放送の字幕を重ねる先 (`live-player` の `paint`) */
    let overlay: HTMLCanvasElement;

    /**
     * **サーバが決めた局で開く** (`+page.server.ts` の `start`)。
     *
     * 名指し (`?service=`) → 覚えている前回の局 → 一覧の先頭、の順で決まって
     * いる。**こちらでも同じ判断をしない** — サーバは既にその局を焼きはじめて
     * いるので (`server/live.ts` の `warm`)、判断がずれると先に焼いたものが
     * 使われないまま別の局が開く
     */
    onMount(() => {
        // 重ねるものの置き場を先に渡す。選局はこのあと
        player.attach(still, overlay);
        if (data.start !== null) void player.tune(video, data.start);
        return () => player.stop();
    });

    /**
     * いま映している局。一覧で目立たせる。
     *
     * **局で引く。** 物理チャンネルで引いていた頃は、**1本に複数の局が乗って
     * いると先頭の局が塗られていた** — MX2 を選んでも MX1 の行が光る。
     * 焼いているのは選んだ局なので (`live.ts`)、絵と印が食い違う
     */
    const current = $derived(channels.find((c) => c.id === player.tuned?.serviceId));

    /*
     * **一覧は種別で切り替える。** 地上波・BS・CS を全部縦に並べると、CS の局が
     * 100を超える環境では地上波が上のほうへ流れて見えなくなる。番組表と
     * 同じ並び・同じ見た目にしてあるので、探す場所がずれない
     */
    const TYPE_LABEL: Record<string, string> = { GR: '地上波', BS: 'BS', CS: 'CS' };
    /** 局を持っている種別だけ出す。BS を繋いでいない環境で空の見出しを出さない */
    const types = $derived(['GR', 'BS', 'CS'].filter((t) => channels.some((c) => c.type === t)));
    /** **開いたときは、いま映している局の種別。** 選び直す手間を増やさない */
    let picked = $state<string | null>(null);
    const shown = $derived(picked ?? current?.type ?? types[0] ?? 'GR');
    const listed = $derived(channels.filter((c) => c.type === shown));

    /**
     * 局を選ぶ。
     *
     * **焼き方は引き継ぐ。** 絵の中身ではなく「その端末で出るか」の話なので、
     * 局を選び直すたびに H.264 へ戻されては選んだ意味が無い。
     *
     * **音声は引き継がない。** あちらは番組ごとに構成が変わるもので、局が変われば
     * 前の合言葉はもう指すものが無い (サーバが主音声に落とす)
     */
    function select(channel: LiveChannel): void {
        void player.tune(video, {
            channelType: channel.type,
            channel: channel.channel,
            serviceId: channel.id,
            codec: player.codec,
        });
    }

    /**
     * 一覧の各行。**開いたときに、いま映しているものまで送るのに要る。**
     *
     * 局が100を超える環境では、覚えていた局が画面の外にあることのほうが普通。
     * 探させるのは、テレビを点けたときの振る舞いから遠い
     */
    const rows: Record<number, HTMLElement | undefined> = $state({});
    /** 一覧そのもの。**送るのはこの中だけ** (下の説明) */
    let list = $state<HTMLElement | null>(null);
    /** 一度送ったら、あとは触らない。見ている途中で勝手に動くと邪魔になる */
    let scrolled = false;
    $effect(() => {
        const row = current === undefined ? undefined : rows[current.id];
        if (scrolled || row === undefined || list === null) return;
        scrolled = true;
        /*
         * **`scrollIntoView` は使わない。ページごと動く。**
         *
         * あれは「その要素が見えるところまで、**動かせるものは何でも動かす**」
         * ので、一覧が中で動けないときは窓のほうが動く。一覧が中で動けるのは
         * 横に並ぶ幅 (lg) だけで、**畳まれた幅では高さの上限が無い** —
         * そこでは映像ごと上へ送られて、開いた瞬間に絵が画面から出ていた。
         * 開き直しでは起きず**読み込み直したときだけ**起きるので
         * (覚えていた局に送るのは1回きり)、「リロードすると画面全体が動く」
         * という出方をする。
         *
         * 動かすのは一覧の中身だけにする。中で動けない幅では**何も起きない**
         * のが正しい — 畳まれた幅では一覧はページの続きなので、そこまで
         * 送ってしまうと今度は映像が見えない
         */
        const room = list.scrollHeight - list.clientHeight;
        if (room <= 0) return;
        // 位置は見えている座標から起こす。offsetTop は入れ子の基準がずれる
        const here = row.getBoundingClientRect();
        const box = list.getBoundingClientRect();
        const middle = list.scrollTop + (here.top - box.top) - (box.height - here.height) / 2;
        list.scrollTop = Math.max(0, Math.min(room, middle));
    });

    /** 全画面。映像だけでなく操作列も一緒に大きくしたいので、箱ごと入れる */
    let fullscreened = $state(false);
    function full(): void {
        const box = video?.parentElement;
        if (box === null || box === undefined) return;
        if (document.fullscreenElement === null) void box.requestFullscreen().catch(() => {});
        else void document.exitFullscreen().catch(() => {});
    }
    $effect(() => {
        const update = () => (fullscreened = document.fullscreenElement !== null);
        document.addEventListener('fullscreenchange', update);
        return () => document.removeEventListener('fullscreenchange', update);
    });

    /**
     * 操作列を出しておく時間 (ms)。**絵の上に居座るものなので、触っていない間は
     * 引っ込める。** 止めている間と、キーボードで触っている間は残す。
     *
     * **指のほうを長くする。** マウスは動かしているだけで出しっぱなしにできるが
     * (`pointermove` が絶えず飛ぶ)、指は置いた瞬間しか報せが来ない。同じ 2.5 秒だと
     * 「触ったら消えた」ようにしか見えず、帯を掴みに行く間も無い
     */
    const LINGER = { mouse: 2500, touch: 5000 };
    let touched = $state(Date.now());
    let keyboard = $state(false);
    let now = $state(Date.now());
    /** 直前に触ったのが指 (かペン) か。**マウスの繋がっていない端末もある** */
    let byTouch = $state(false);
    /*
     * **見るのは「触ったか」と「止めているか」だけ。** 再生できているかどうかを
     * 混ぜていた頃は、繋いでいる間ずっと出たままになり、消える経路を
     * 確かめようが無かった。繋いでいる間も、動かせばすぐ戻る
     */
    const controlsShown = $derived(
        player.paused || keyboard || now - touched < (byTouch ? LINGER.touch : LINGER.mouse),
    );
    /** 消す時刻を跨ぐためだけの目覚まし。出ている間しか回さない */
    $effect(() => {
        if (controlsShown === false) return;
        const timer = setInterval(() => (now = Date.now()), 250);
        return () => clearInterval(timer);
    });
    const wake = (event: PointerEvent) => {
        byTouch = event.pointerType !== 'mouse';
        touched = Date.now();
        now = touched;
    };
    /**
     * 出ていく先で消す。**指のときは消さない。**
     *
     * 指を離すとブラウザはその場でポインタを取り下げるので、`pointerleave` が
     * **触った直後に必ず飛ぶ**。マウスと同じに扱っていたので、タッチの端末では
     * **触った瞬間に操作列が消えて**いた (帯を掴むどころではない)。
     * マウスは絵の外へ出たなら本当に離れているので、そちらは今までどおり消す
     */
    const away = (event: PointerEvent) => {
        if (event.pointerType === 'mouse') touched = 0;
    };

    /**
     * 絵の上に置くボタンの色。**自分で決める。**
     *
     * `btn-ghost` にしていた頃は daisyUI が主題の文字色を当てるので、暗い絵と
     * 下の黒いぼかしに**アイコンが沈んで見えなく**なっていた
     */
    const OVERLAY = 'border-0 bg-black/45 text-white shadow-none hover:bg-black/70';

    /**
     * **アイコンは既存の画面と同じ書き方に揃える** (インラインの SVG)。
     * 絵文字にしていた頃は、端末ごとに形も大きさも変わっていた
     */
    const PLAY = 'M8 5v14l11-7z';
    const PAUSE = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
    const SOUND_ON =
        'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';
    const SOUND_OFF =
        'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z';
    const AUDIO = 'M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z';
    const CAPTION =
        'M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z';
    const EXPAND = 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z';
    const SHRINK = 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z';
</script>

{#snippet icon(path: string)}
    <svg viewBox="0 0 24 24" class="size-5" fill="currentColor" aria-hidden="true">
        <path d={path} />
    </svg>
{/snippet}

<!--
    **映像を左、局を右。** 動画を見ながら次を選べる並びで、YouTube の再生画面と
    同じ形。畳まれる幅では縦に積む (横に並べると映像が切手大になる)。

    **広い画面ではページごとスクロールさせない** (`+layout.svelte` の `fill`)。
    映像を見ながら選ぶものなので、ページが動くと絵が画面から出ていく。
    動くのは右の一覧だけ。`min-h-0` が要る — 付けないと flex の子は中身の高さで
    突っ張って、外側の `overflow` が効かない
-->
<div class="flex flex-col gap-4 lg:h-full lg:min-h-0 lg:flex-row" data-testid="live">
    <div class="flex min-w-0 flex-1 flex-col lg:min-h-0">
        <!-- 映像は高さのほうを上限にする。横幅いっぱいにすると縦がはみ出す -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="bg-base-300 relative aspect-video max-h-full overflow-hidden rounded-lg
                   {controlsShown ? '' : 'cursor-none'}"
            onpointermove={wake}
            onpointerdown={wake}
            onpointerleave={away}
            onfocusin={() => (keyboard = true)}
            onfocusout={() => (keyboard = false)}
        >
            <!-- svelte-ignore a11y_media_has_caption -->
            <!--
                字幕は `<track>` ではない。放送の字幕は文字ではなく**絵**として
                届くので (docs/stream.md §5.2)、下の canvas に重ねる
            -->
            <!--
                **`autoplay` と `muted` は付けない。** 鳴らし始めるのは
                `live-player` の役目で、音ありで断られたときだけ自分で黙る。
                ここで `muted` にすると、断られていないときまで無音になる
            -->
            <!--
                **備え付けの操作は出さない** (`controls` を付けない)。あれの
                再生位置は「持っている範囲」を尺として描くので、0.05秒ごとに
                中身が届くたびに右へ左へ動く。放送に終わりは無いのだから、
                位置ではなく**張り付いているかどうか**を出すのが正しい
            -->
            <video bind:this={video} class="h-full w-full bg-black" playsinline data-testid="live-video"
            ></video>

            <!--
                **切り替えの間、前の絵を貼っておく。** 器を作り直すと `<video>` は
                何も映さなくなるので、そのままだと 1.6 秒ほど真っ黒になる。
                待ち時間そのものは削れない (電波の同期待ちと GOP の頭待ち) が、
                黒い画面を見せずに済む。

                絵は止まって見えるが、それは正しい — 実際に止まっている
            -->
            <canvas
                bind:this={still}
                class="pointer-events-none absolute inset-0 h-full w-full object-contain
                       transition-opacity duration-150
                       {player.holding ? 'opacity-100' : 'opacity-0'}"
                data-testid="live-still"
                data-holding={player.holding}
                aria-hidden="true"
            ></canvas>

            <!--
                **放送の字幕。** 文字ではなく絵で届く (放送に乗っているのは文字と
                描き方の指定で、テレビはそれを見て毎回自分で描いている)。
                サーバが libaribcaption に描かせたものを重ねるので、**録画で見る
                字幕と同じ絵**になる。

                絵は画面まるごと (1920x1080) で来るので、映像と同じ枠に敷いて
                引き伸ばすだけでよい。位置合わせはブラウザ任せ。
                **前の絵より上に置く** — 切り替え中は字幕も一緒に止まってほしい
            -->
            <canvas
                bind:this={overlay}
                class="pointer-events-none absolute inset-0 h-full w-full object-contain"
                data-testid="live-captions"
                data-on={player.captions && player.hasCaptions}
                aria-hidden="true"
            ></canvas>

            {#if player.tuned !== null && player.state !== 'error'}
                <!--
                    自前の操作列。**放送の今に居るときは右端に張り付く。**
                    止めても受け取りは続くので、止めた所から見られる。

                    絵が出る前から出しておく — 出たり消えたりすると、押そうとした
                    ところで動くことになる
                -->
                <!--
                    **しばらく触らなければ消える。** 絵の上に居座るものなので、
                    見ている間は引っ込んでいるほうがいい。止めている間と、
                    キーボードで触っている間は残す
                -->
                <div
                    class="absolute right-0 bottom-0 left-0 flex items-center gap-2
                           bg-gradient-to-t from-black/80 to-transparent px-3 pt-8 pb-3 text-white
                           transition-opacity duration-200
                           {controlsShown ? 'opacity-100' : 'pointer-events-none opacity-0'}"
                    data-testid="live-controls"
                    data-shown={controlsShown}
                >
                    <button
                        class="btn btn-circle btn-sm {OVERLAY}"
                        onclick={() => player.toggle()}
                        aria-label={player.paused ? '再生' : '一時停止'}
                        data-testid="live-play"
                    >
                        {@render icon(player.paused ? PLAY : PAUSE)}
                    </button>

                    <button
                        class="btn btn-circle btn-sm {OVERLAY}"
                        onclick={() => (player.silenced ? player.unmute() : player.mute())}
                        aria-label={player.silenced ? '音を出す' : '音を消す'}
                        data-testid="live-sound"
                    >
                        {@render icon(player.silenced ? SOUND_OFF : SOUND_ON)}
                    </button>

                    <!--
                        **字幕の出し入れ。流れてきている番組でだけ出す。**

                        字幕の無い番組で押せる形にしておくと、押しても何も起きない
                        操作が並ぶ。テレビの字幕ボタンと同じで、出しているかどうかは
                        色で分かるようにする
                    -->
                    {#if player.hasCaptions}
                        <button
                            class="btn btn-circle btn-sm {player.captions
                                ? 'border-0 shadow-none btn-primary'
                                : OVERLAY}"
                            onclick={() => player.toggleCaptions()}
                            aria-label={player.captions ? '字幕を消す' : '字幕を出す'}
                            aria-pressed={player.captions}
                            data-testid="live-caption"
                        >
                            {@render icon(CAPTION)}
                        </button>
                    {/if}

                    <!--
                        **字幕の選び直し。言語が2つ以上あるときだけ出す。**

                        音声と違って映像は焼き直しにならない (字幕は別の ffmpeg
                        なので、そちらだけ入れ替わる)
                    -->
                    {#if player.captions && player.captionTracks.length > 1}
                        <div class="dropdown dropdown-top">
                            <button
                                class="btn btn-sm {OVERLAY}"
                                aria-label="字幕を選ぶ"
                                data-testid="live-caption-track"
                            >
                                <span class="max-w-28 truncate">
                                    {player.captionTracks.find((t) => t.index === player.captionTrack)
                                        ?.label ?? '字幕'}
                                </span>
                            </button>
                            <ul
                                class="dropdown-content menu bg-base-100 text-base-content rounded-box
                                       z-10 mb-1 w-52 p-2 shadow-lg"
                                data-testid="live-caption-menu"
                            >
                                {#each player.captionTracks as track (track.index)}
                                    <li>
                                        <button
                                            class={track.index === player.captionTrack ? 'menu-active' : ''}
                                            onclick={(event) => {
                                                player.setCaptionTrack(track.index);
                                                event.currentTarget.blur();
                                            }}
                                            data-testid="live-caption-option"
                                            data-track={track.index}
                                            aria-current={track.index === player.captionTrack
                                                ? 'true'
                                                : undefined}
                                        >
                                            {track.label}
                                        </button>
                                    </li>
                                {/each}
                            </ul>
                        </div>
                    {/if}

                    <!--
                        **焼き方の切り替え。**

                        絵の中身ではなく「その端末で出るかどうか」の話なので、
                        音声とは別に並べる。AV1 は実時間に間に合う (`server/live.ts`)
                        が、**出ないブラウザもある** — 受け取れなければ H.264 に
                        戻して、戻した理由を出す (`live-player.svelte.ts` の `start`)。

                        押すと焼き直しになるので絵が一瞬止まるが、チャンネルは
                        変わらないので前の絵を貼ったまま差し替わる
                    -->
                    <div class="dropdown dropdown-top">
                        <button
                            class="btn btn-sm gap-1.5 {OVERLAY}"
                            aria-label="焼き方を選ぶ"
                            data-testid="live-codec"
                        >
                            <span class="text-xs font-semibold">
                                {LIVE_CODECS.find((c) => c.id === player.codec)?.label ?? 'H.264'}
                            </span>
                        </button>
                        <ul
                            class="dropdown-content menu bg-base-100 text-base-content rounded-box
                                   z-10 mb-1 w-56 p-2 shadow-lg"
                            data-testid="live-codec-menu"
                        >
                            {#each LIVE_CODECS as choice (choice.id)}
                                <li>
                                    <button
                                        class={choice.id === player.codec ? 'menu-active' : ''}
                                        onclick={(event) => {
                                            player.setCodec(choice.id);
                                            // 選んだら閉じる。開きっぱなしだと絵を覆う
                                            event.currentTarget.blur();
                                        }}
                                        data-testid="live-codec-option"
                                        data-codec={choice.id}
                                        aria-current={choice.id === player.codec ? 'true' : undefined}
                                    >
                                        <span class="flex flex-col items-start">
                                            <span>{choice.label}</span>
                                            <span class="text-base-content/60 text-xs">{choice.note}</span>
                                        </span>
                                    </button>
                                </li>
                            {/each}
                        </ul>
                    </div>

                    <!--
                        **音声の選び直し。選べるものが2つ以上あるときだけ出す。**

                        二カ国語 (1本の中に主/副が左右で入っている) と、音声が
                        2本以上入っているものの両方がここに平らに並ぶ — 見ている
                        人にとってはどちらも「音声を選ぶ」1つの操作でしかない。

                        押すと焼き直しになるので絵が一瞬止まるが、チャンネルは
                        変わらないので前の絵を貼ったまま差し替わる
                    -->
                    {#if player.audios.length > 1}
                        <div class="dropdown dropdown-top">
                            <button
                                class="btn btn-sm gap-1.5 {OVERLAY}"
                                aria-label="音声を選ぶ"
                                data-testid="live-audio"
                            >
                                {@render icon(AUDIO)}
                                <span class="hidden max-w-28 truncate sm:inline">
                                    {player.audios.find((a) => a.id === player.audio)?.label ?? '音声'}
                                </span>
                            </button>
                            <ul
                                class="dropdown-content menu bg-base-100 text-base-content rounded-box
                                       z-10 mb-1 w-52 p-2 shadow-lg"
                                data-testid="live-audio-menu"
                            >
                                {#each player.audios as track (track.id)}
                                    <li>
                                        <button
                                            class={track.id === player.audio ? 'menu-active' : ''}
                                            onclick={(event) => {
                                                player.setAudio(track.id);
                                                // 選んだら閉じる。開きっぱなしだと絵を覆う
                                                event.currentTarget.blur();
                                            }}
                                            data-testid="live-audio-option"
                                            data-audio={track.id}
                                            aria-current={track.id === player.audio ? 'true' : undefined}
                                        >
                                            {track.label}
                                        </button>
                                    </li>
                                {/each}
                            </ul>
                        </div>
                    {/if}

                    <!--
                        戻れる範囲の中のどこに居るか。押すとその時刻へ移る。

                        **放送の今に居る間は右端に張り付かせる。** 実際には
                        貯めているぶん (0.5秒ほど) 後ろに居るが、そこを描くと
                        溜まりが増えるたびに摘みが左へ動く — 見ている人には
                        「勝手に戻っている」としか映らない
                    -->
                    <input
                        type="range"
                        class="range range-xs range-error mx-1 flex-1"
                        min={player.oldest}
                        max={player.newest}
                        step="0.1"
                        value={player.live ? player.newest : player.position}
                        oninput={(event) => player.seek(Number(event.currentTarget.value))}
                        aria-label="再生位置"
                        data-testid="live-seek"
                    />

                    <!--
                        **追っかけ中の速さ。追っかけている間だけ出す。**

                        ライブに張り付いているときは速められない (放送より先は
                        無い)。追いついたら自分でライブに戻るので、そのとき
                        この選択肢も消える
                    -->
                    {#if player.chasing}
                        <div class="dropdown dropdown-top dropdown-end">
                            <button
                                class="btn btn-sm tabular-nums {OVERLAY}"
                                aria-label="追っかけの速さ"
                                data-testid="live-speed"
                            >
                                {player.speed}×
                            </button>
                            <ul
                                class="dropdown-content menu bg-base-100 text-base-content rounded-box
                                       z-10 mb-1 w-28 p-2 shadow-lg"
                                data-testid="live-speed-menu"
                            >
                                {#each SPEEDS as value (value)}
                                    <li>
                                        <button
                                            class="tabular-nums {value === player.speed ? 'menu-active' : ''}"
                                            onclick={(event) => {
                                                player.setSpeed(value);
                                                event.currentTarget.blur();
                                            }}
                                            data-testid="live-speed-option"
                                            data-speed={value}
                                            aria-current={value === player.speed ? 'true' : undefined}
                                        >
                                            {value}×
                                        </button>
                                    </li>
                                {/each}
                            </ul>
                        </div>
                    {/if}

                    <!-- 放送の今に居るかどうか。離れていれば押して戻れる -->
                    <button
                        class="btn btn-sm gap-1.5 {player.live ? 'border-0 shadow-none btn-error' : OVERLAY}"
                        onclick={() => player.goLive()}
                        data-testid="live-edge"
                    >
                        <span
                            class="inline-block size-2 rounded-full {player.live
                                ? 'bg-error-content'
                                : 'bg-error'}"
                        ></span>
                        ライブ
                    </button>

                    <button
                        class="btn btn-circle btn-sm {OVERLAY}"
                        onclick={() => full()}
                        aria-label={fullscreened ? '全画面をやめる' : '全画面'}
                        data-testid="live-full"
                    >
                        {@render icon(fullscreened ? SHRINK : EXPAND)}
                    </button>
                </div>
            {/if}

            {#if player.silenced && player.state === 'playing'}
                <!--
                    **押されるまで音は出せない。** 前回のチャンネルで勝手に
                    始める作りなので、開いた直後は「押した」ことになっておらず、
                    ブラウザが音ありの再生を断る。押せる場所を出す
                -->
                <button
                    class="btn btn-sm btn-neutral absolute top-3 left-3 gap-2"
                    onclick={() => player.unmute()}
                    data-testid="live-unmute"
                >
                    音を出す
                </button>
            {/if}

            <!--
                **頼まれたとおりにできなかったときの断り書き。**

                失敗ではないので、絵は出ている。いまのところ「AV1 を出せない端末
                なので H.264 に戻した」の1つだけ。黙って別の形にすると、なぜ
                切り替えが効かないのか分からない
            -->
            {#if player.warning}
                <div
                    class="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2"
                    data-testid="live-warning"
                >
                    <span class="rounded-box bg-black/60 px-3 py-1 text-xs text-white">
                        {player.warning}
                    </span>
                </div>
            {/if}

            {#if player.state !== 'playing'}
                <!--
                    何も出ていない間に何が起きているかを出す。黒いままだと壊れて見える。

                    **前の絵を貼っている間は塗り潰さない。** 覆ってしまうと、
                    貼っている意味が無くなる (実機で撮ると、前の絵が白くかすんだ
                    だけの画面になっていた)。回っているものだけを、どんな絵の上でも
                    見えるように小さく敷いて出す。

                    **押せる邪魔をしない** (`pointer-events-none`)。箱いっぱいに
                    広がるので、そのままだと下の操作列を覆って押せなくなる。
                    中の「やり直す」だけは押せるように戻す
                -->
                <div
                    class="pointer-events-none absolute inset-0 flex items-center justify-center
                           {player.holding ? '' : 'bg-base-300/80'}"
                    data-testid="live-status"
                    data-veiled={!player.holding}
                >
                    {#if player.state === 'connecting'}
                        <!--
                            **敷くのは外側。** daisyUI の `loading` は自分の
                            `background-color` で回る絵を塗っているので、そこへ
                            `bg-*` を足すと**回っているものの色を上書きする** —
                            敷いたつもりが、見えなくなる
                        -->
                        <span class={player.holding ? 'rounded-box bg-black/45 p-3 text-white' : 'contents'}>
                            <span class="loading loading-spinner loading-lg"></span>
                        </span>
                    {:else if player.state === 'error'}
                        <div class="text-center">
                            <div class="text-error font-medium">{player.message}</div>
                            <button
                                class="btn pointer-events-auto btn-sm mt-3"
                                onclick={() => current && select(current)}
                                data-testid="live-retry">やり直す</button
                            >
                        </div>
                    {:else}
                        <span class="text-base-content/60">選んでください</span>
                    {/if}
                </div>
            {/if}
        </div>

        {#if current}
            <div class="mt-3">
                <h1 class="text-lg font-bold" data-testid="live-title">
                    {current.now?.name ?? current.name}
                </h1>
                <p class="text-base-content/60 mt-1 text-sm">
                    {current.name}
                    {#if current.now}
                        ・ {time(current.now.startAt)} 〜 {time(current.now.endAt)}
                    {/if}
                    <!--
                        **放送からどれだけ遅れているか。** 詰めていく作業をするのに、
                        見えないと当てずっぽうになる
                    -->
                    {#if player.delay !== null}
                        ・ <span data-testid="live-delay">遅延 {player.delay.toFixed(1)}秒</span>
                    {/if}
                </p>
            </div>
        {/if}
    </div>

    <!--
        **右の列。** 幅は固定にして、映像側だけ伸ばす。番組表と同じ並び
        (リモコン番号順、持たない局は物理チャンネル順) にしてあるので、
        番組表で見つけた局をここでも同じ位置で探せる。

        **高さは残りぜんぶ。** `max-h-[70vh]` で切っていた頃は、画面の下に
        余白があるのに一覧のほうが先に終わっていた
    -->
    <aside class="flex flex-col lg:min-h-0 lg:w-80 lg:shrink-0">
        <!-- 番組表と同じ並び・同じ見た目。探す場所がずれないようにする -->
        <div class="join mb-2" data-testid="live-type-tabs">
            {#each types as type (type)}
                <button
                    class="btn join-item btn-sm {shown === type ? 'btn-active' : ''}"
                    onclick={() => (picked = type)}
                    data-testid="live-type-{type}"
                >
                    {TYPE_LABEL[type]}
                </button>
            {/each}
        </div>
        <!--
            **押せると分かる形にする。** 平らに並べていた頃は、文字が並んでいる
            だけに見えて押せると気付けなかった。枠を持たせ、指を乗せると浮かせ、
            いま映しているものは色で塗る
        -->
        <ul bind:this={list} class="flex-1 space-y-1 overflow-y-auto lg:min-h-0" data-testid="live-channels">
            {#each listed as channel (channel.id)}
                <!-- いま映しているものかどうかは、この行の中で5回使う -->
                {@const tuned = current?.id === channel.id}
                <li>
                    <button
                        bind:this={rows[channel.id]}
                        class="flex w-full cursor-pointer items-center gap-3 rounded-lg border p-2 text-left
                               transition-colors
                               {tuned
                            ? 'border-primary bg-primary/15 ring-primary/40 ring-1'
                            : 'border-base-300 hover:border-base-content/30 hover:bg-base-200'}"
                        onclick={() => select(channel)}
                        aria-current={tuned ? 'true' : undefined}
                        data-testid="live-channel"
                        data-current={tuned ? 'true' : 'false'}
                        data-channel="{channel.type}/{channel.channel}"
                        data-service={channel.id}
                    >
                        <!--
                            **テレビに出ている番号を添える。** 地上波はリモコン番号、
                            BS/CS は3桁番号 (BS朝日1=151)。局名だけだと、テレビで
                            覚えている番号から探せない
                        -->
                        <span
                            class="text-base-content/50 w-7 shrink-0 text-right font-mono text-xs
                                   tabular-nums"
                            data-testid="live-number"
                        >
                            {channel.number ?? ''}
                        </span>
                        {#if channel.hasLogo}
                            <img
                                src="/api/services/{channel.id}/logo"
                                alt=""
                                class="size-8 shrink-0 rounded object-contain"
                            />
                        {:else}
                            <span
                                class="bg-base-300 flex size-8 shrink-0 items-center justify-center rounded text-xs"
                            >
                                {channel.type}
                            </span>
                        {/if}
                        <span class="min-w-0 flex-1">
                            <span
                                class="block truncate text-sm font-medium
                                       {tuned ? 'text-primary' : ''}"
                            >
                                {channel.name}
                            </span>
                            {#if channel.now}
                                <span class="text-base-content/60 block truncate text-xs">
                                    {channel.now.name}
                                </span>
                            {/if}
                        </span>
                        <!-- いま映しているもの。色だけだと、色の見え方が違う人に伝わらない -->
                        {#if tuned}
                            <span class="badge badge-primary badge-sm shrink-0">視聴中</span>
                        {/if}
                    </button>
                </li>
            {/each}
        </ul>
    </aside>
</div>
