<script lang="ts">
    import { submitting } from '$lib/actions';
    import ProgramDetail from '$lib/components/ProgramDetail.svelte';
    import Toasts, { type Notice } from '$lib/components/Toasts.svelte';
    import { liveUpdates } from '$lib/live-updates.svelte';
    import { playLinks, withCredentials } from '$lib/play';
    import { playTarget } from '$lib/play.svelte';
    import {
        badgeClass,
        date,
        dateTime,
        duration,
        eta,
        cmNoteWorthShowing,
        logoUnusable,
        percent,
        recordedDuration,
        rowState,
        size,
        stateLabel,
        time,
    } from '$lib/format';
    import { type DetailSeed, programDetail } from '$lib/detail.svelte';
    import { encodeSource } from '$lib/source';

    let { data, form } = $props();

    // 予約・録画のどちらが動いてもサーバが知らせてくる
    liveUpdates(['recordings', 'reservations']);

    const active = ['scheduled', 'conflict', 'recording'];

    // どのプレイヤーに渡すか (play.svelte.ts)。番組表の画面と同じ決め方
    const target = playTarget(() => data);
    const platform = $derived(target.platform);
    const origin = $derived(target.origin);

    /** プレイヤーに渡すので絶対URLにする */
    const fileUrl = (id: number) => `${origin}/api/recordings/${id}/file`;

    /*
     * ダウンロードも資格情報を URL に入れる。ブラウザは画面を開いたときの認証を
     * ダウンロードに引き継がないので、素のURLだと 401 になって落ちてこない。
     * ?download=1 でサーバが添付として返し、ファイル名も付く
     */
    const downloadUrl = (id: number, source?: 'ts' | 'encoded') =>
        withCredentials(
            `${origin}/api/recordings/${id}/file?download=1${source === undefined ? '' : `&source=${source}`}`,
            data.credentials,
        );

    /**
     * 焼いたものと生TSが**両方とも残っている**か。
     *
     * 「生TSも残す」で録ると、焼き上がったあとも元が消えずに残る。そのとき
     * 落とす口が1つだと、寄越されるのは焼いたほうだけで、**元には手が届かない**
     * (画質を落としていない元が欲しい場面はある)。
     *
     * **焼いている最中は数えない。** その間の配信は生TSのほうを返すので
     * (`api/recordings/[id]/file`)、2つ並べると押した先が同じものになる
     */
    function bothFiles(rec: (typeof data.recordings)[number]): boolean {
        return rec.job_id === null && rec.library_path !== null && rec.ts_path !== null;
    }

    /** 押した結果。出す場所と消え方は Toasts が持っている */
    const notices = $derived.by(() => {
        const list: Notice[] = [];
        if (form?.message) list.push({ key: 'dashboard-error', kind: 'error', text: form.message });
        if (form?.reconcile) {
            /*
             * **両方向ぶん出す。** 「実体が無く削除済み」だけ出していた頃は、
             * 逆向き (行の無いファイル) を見ていないことが画面から分からなかった。
             * 動画そのものには触らないので、その数だけは出しておく
             */
            const { checked, removed, swept, strays } = form.reconcile;
            const parts = [`照合 ${checked} 件`, `実体が無く削除済み ${removed} 件`];
            if (swept > 0) parts.push(`連れ合いの無い付き添いを片付け ${swept} 件`);
            if (strays > 0) parts.push(`DBに無い動画 ${strays} 件 (消していません)`);
            list.push({ key: 'reconcile-result', kind: 'info', text: parts.join(' / ') });
        }
        return list;
    });

    /** 行から開いた番組詳細。番組表と同じ見せ方をする (detail.svelte.ts) */
    const detail = programDetail();
    /** その行が失敗・削除された理由。詳細の中で見せる */
    let detailNotes = $state<{ title: string; text: string }[]>([]);
    /**
     * 何で検出したか。ロゴが効いているかどうかがここで分かる。
     * うまくいったときは持たない (`cmNoteWorthShowing`)
     */
    let detailCmNote = $state<string | null>(null);
    /**
     * 詳細を開いている録画。**予約から開いたときは null。**
     *
     * ダウンロードと録り直しはここから出す。一覧の行に並べていた頃は、
     * 1行あたり4つも5つもボタンが並んで、狭い画面では横に流れていた。
     * どちらもその1本に対する操作なので、中身を見ている場所にある
     */
    let detailRec = $state<(typeof data.recordings)[number] | null>(null);

    /**
     * 行を押したら番組詳細を出す。中身の出し方は `detail` が持っている。
     * ここで決めるのは、その行に添える札 (失敗の理由・CMの判定) だけ。
     */
    function openDetail(
        programId: number | null,
        row: DetailSeed,
        notes: { title: string; text: string }[] = [],
        cmNote: string | null = null,
    ): void {
        // 予約から開いたときは録画のボタンを出さない (openRecording が入れ直す)
        detailRec = null;
        detailNotes = notes;
        detailCmNote = cmNoteWorthShowing(cmNote) ? cmNote : null;
        void detail.open(programId, row);
    }

    /**
     * 削除は2回押させる。1回目で聞き返し、2回目で本当に消す。
     * 行のすぐ隣に並んでいるので、押し間違いで消えると取り返しがつかない。
     * 少し置いたら元に戻す(押したことを忘れた頃に消えないように)
     */
    let armed = $state<number | null>(null);
    let disarm: ReturnType<typeof setTimeout> | undefined;
    function arm(id: number): void {
        armed = id;
        clearTimeout(disarm);
        disarm = setTimeout(() => (armed = null), 5000);
    }

    /**
     * **他所を触ったら、聞き返しは取り下げる。**
     *
     * 聞き返しの間だけ「確定」が出ていて、押せば消える。時間で戻すだけだと、
     * 間違えて押したことに気付いて別のところを触っても**まだ構えたまま**で、
     * その5秒のうちに同じ場所をもう一度押すと消えてしまう。やめたことは
     * 他所を触った時点で分かる。
     *
     * 削除まわりの2つだけ除く — 「削除」は次の行を構える押し方
     * (この後 `arm` が入れ直す)、「確定」はまさに実行する押し方
     */
    function stand(event: MouseEvent): void {
        if (armed === null) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('[data-testid="delete-button"], [data-testid="delete-confirm"]')) return;
        clearTimeout(disarm);
        armed = null;
    }

    /**
     * 行のどこを押しても、その行でいちばんやりたいことをする。
     * ボタンやリンクを押したときは邪魔しない。
     *
     * 録画なら**再生**。一覧を開くのは観るためなので、そこを1回で通す。
     * 中身を読みたいときは行の中の「詳細」から。
     * 予約は再生するものが無いので、そのまま詳細を出す。
     */
    function rowClick(event: MouseEvent | KeyboardEvent, play: string | null, open: () => void): void {
        if (event instanceof KeyboardEvent && event.key !== 'Enter') return;
        if ((event.target as HTMLElement).closest('a, button, input, label')) return;
        if (play !== null) location.href = play;
        else open();
    }

    /**
     * その録画を開くリンク。再生できないものには無い。
     *
     * ブラウザは MPEG-2 も AV1+Opus の mkv も素直には再生できないので、
     * 端末に入っているプレイヤーに URL を渡して開かせる (play.ts)
     */
    function playLink(rec: (typeof data.recordings)[number]) {
        if (!playable(rec)) return null;
        return playLinks(fileUrl(rec.id), rec.name, platform, data.credentials)[0] ?? null;
    }

    /**
     * 観られる録画かどうか。
     *
     * **録画そのものが失敗したものは観られない。** 途中まで書けたファイルが
     * 残っていることはあるが、頭からスクランブルが掛かっていたり中身が空だったりで、
     * 押してもプレイヤーが黙って閉じるだけだった。録り直しの口も同じ理由で出さない
     * (元になる生TSが使えないので、やり直しても同じところで失敗する)
     */
    function playable(rec: (typeof data.recordings)[number]): boolean {
        if (rec.deleted_at !== null) return false;
        if ((rec.library_path ?? rec.ts_path) === null) return false;
        /*
         * **エンコードの失敗はここに出てこない。** 落ちたのは焼き直しのほうで
         * 生TSは無事なので、観られるし、やり直しもできる。
         * エンコードで落ちると録画の状態まで 'failed' にしていた頃は、
         * 中身のあるTSを持っているのに再生もダウンロードもできなかった
         */
        return rec.state !== 'failed';
    }

    /**
     * 録画の詳細。
     *
     * 失敗の理由は**ここでしか出さない**。一覧の行に生のエラーを並べていた頃は、
     * 数行ぶんの高さを1行が占めて、他の録画が画面から押し出されていた。
     *
     * 理由は3種類あって、それぞれ別物。見出しを付けて分けて渡す。
     * 「エンコードに失敗しました」で全部まとめていた頃は、録画そのものが
     * 失敗した行を開いても嘘の見出しが出ていた
     */
    function openRecording(rec: (typeof data.recordings)[number]): void {
        const notes: { title: string; text: string }[] = [];
        // error 列に入るのは**録画そのものの失敗だけ**。エンコードの理由は encode_error
        if (rec.state === 'failed' && rec.error) {
            notes.push({ title: '録画に失敗しました', text: rec.error });
        }
        if (rec.deleted_at !== null && rec.error) {
            notes.push({ title: '削除された理由', text: rec.error });
        }
        if (rec.encode_error) {
            notes.push({ title: 'エンコードに失敗しました', text: rec.encode_error });
        }
        openDetail(rec.program_id, rec, notes, rec.cm_note);
        detailRec = rec;
    }
</script>

<!-- 聞き返しは他所を触ったら取り下げる (`stand`) -->
<svelte:window onclick={stand} />

<!--
    予約も録画も、行の形を揃える。

    以前は列に分けた表だった。状態も日時もサイズも1列ずつ持たせていたので、
    タブレットくらいの幅で表そのものが横スクロールになり、番組名が隠れていた。
    列を減らすと今度は画面ごとに出るものが違ってしまう。

    そこで**どの幅でも同じ1つの形**にした。左に「状態 + 番組名 + その他ぜんぶ」、
    右に押すもの。狭いところでは押すものが下へ回り込むだけで、出るものは変わらない。
    押すものは指で押せる大きさ (既定の btn) にしてある
-->
{#snippet title(state: string, badge: string, name: string, testid: string)}
    <div class="flex flex-wrap items-center gap-2">
        <span class="badge whitespace-nowrap {badge}" data-testid={testid}>{state}</span>
        <span class="font-medium break-words">{name}</span>
    </div>
{/snippet}

<!-- 局名・放送日時・尺・サイズ。1行にまとめて、空のものは出さない -->
{#snippet meta(parts: string[])}
    <div class="text-base-content/60 mt-1 text-sm break-words">
        {parts.filter(Boolean).join(' ・ ')}
    </div>
{/snippet}

<!--
    **何でこの1本が立ったのか。** 予約にも録画にも同じ形で出す。

    録画の側に出していなかった頃は、録れたものを見ても「どのルールが拾ったのか」が
    分からなかった。要らないものが混ざっていたときに、直す先 (どのルールの条件か)
    を探すのに番組名からルールを推し量るしかなかった。

    ルール名をそのまま入口にする。行にボタンを足すと窮屈になる
-->
{#snippet source(ruleId: number | null, ruleName: string | null, manual: boolean)}
    <div class="text-base-content/60 mt-0.5 text-xs" data-testid="rule-name">
        {#if manual}
            手動予約
        {:else}
            ルール:
            {#if ruleId !== null}
                <a class="link" href="/rules?edit={ruleId}">{ruleName}</a>
            {:else}
                (削除済み)
            {/if}
        {/if}
    </div>
{/snippet}

<!--
    広い画面では2つの一覧を横に並べ、画面の残りを丁度使い切る。
    高さをJSで測って入れていた頃は、測る前の当ての値で一度描かれるので
    読み込むたびに一覧が縮んだ状態から伸びて見えた。ここは全部 CSS で決める。

    畳まれる幅 (lg 未満) では素直にページごとスクロールさせる。
    小さい画面で中だけスクロールさせると、指の届く範囲が二重になって使いづらい
-->
<div class="lg:flex lg:h-full lg:flex-col">
    <h1 class="mb-4 text-2xl font-bold">予約と録画</h1>

    <Toasts {notices} source={form} />

    <div class="grid gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-5">
        <!--
        min-w-0 が無いと、中の表の幅にグリッドの列が引きずられてページごとはみ出す。
        1列に畳まれたときは録画を先に出す(見るのはたいてい録れたほうなので)
    -->
        <section class="order-2 min-w-0 lg:order-none lg:col-span-2 lg:flex lg:min-h-0 lg:flex-col">
            <div class="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-2">
                <h2 class="text-lg font-bold">予約</h2>
                <!--
                    「競合を再計算」は置いていない。番組表を取り直したときとルールを
                    いじったときに必ず走るので、押す機会が無かった
                -->
                <a class="btn btn-sm" href={data.showFinished ? '/' : '/?all=1'}>
                    {data.showFinished ? '進行中のみ' : '完了分も表示'}
                </a>
            </div>

            <!--
            残りいっぱいまで伸ばして、中だけスクロールさせる。2つ並べたときに、
            片方が長いともう片方が下に置いていかれるため
        -->
            <div class="overflow-auto rounded-box bg-base-100 shadow lg:min-h-0 lg:flex-1">
                <div class="divide-base-300 divide-y" data-testid="reservation-list">
                    {#each data.reservations as res (res.id)}
                        <!-- 行を押すと番組表と同じ詳細が出る -->
                        <div
                            data-testid="reservation-row"
                            data-reservation-id={res.id}
                            data-program-id={res.program_id}
                            class="hover:bg-base-200/60 relative cursor-pointer p-3"
                            role="button"
                            tabindex="0"
                            onclick={(event) => rowClick(event, null, () => openDetail(res.program_id, res))}
                            onkeydown={(event) =>
                                rowClick(event, null, () => openDetail(res.program_id, res))}
                        >
                            <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
                                <div class="min-w-0 flex-1 basis-56" data-testid="row-body">
                                    {@render title(
                                        stateLabel(res.state),
                                        badgeClass(res.state),
                                        res.name,
                                        'reservation-state',
                                    )}
                                    {@render meta([
                                        res.service_name,
                                        `${dateTime(res.start_at)}〜${time(res.end_at)} (${duration(res.start_at, res.end_at)})`,
                                    ])}
                                    {#if res.conflict_reason}
                                        <div class="text-error mt-0.5 text-sm">{res.conflict_reason}</div>
                                    {/if}
                                    <!--
                                        手動なら何も出さない。既定と違うときだけ言う。
                                        **録画の側では手動とも書く** — 録れたものは後から
                                        見返すので、「ルールではない」ことにも意味がある
                                    -->
                                    {#if !res.manual}
                                        {@render source(res.rule_id, res.rule_name, false)}
                                    {/if}
                                    <!--
                                        **焼き方の札は出さない。**

                                        予約の行にも「TSのみ」「生TSも残す」が写して
                                        あったが、それは予約を立てた時点の値で、実際に
                                        効くのは**焼くときの設定** (settings)。
                                        設定を変えても札は昔のまま残るので、画面が
                                        嘘をついていた。決まるところは設定画面ひとつ
                                    -->
                                </div>

                                <div class="flex shrink-0 flex-wrap items-center gap-2">
                                    {#if active.includes(res.state)}
                                        <form method="POST" action="?/cancel" use:submitting>
                                            <input type="hidden" name="id" value={res.id} />
                                            <button
                                                class="btn btn-error btn-outline"
                                                data-testid="cancel-button"
                                            >
                                                取消
                                            </button>
                                        </form>
                                    {:else if res.state === 'canceled' && res.end_at > Date.now()}
                                        <!--
                                            取り消した予約はルールが作り直さないので、
                                            気が変わったときに戻せるのはここだけ
                                        -->
                                        <form method="POST" action="?/restore" use:submitting>
                                            <input type="hidden" name="id" value={res.id} />
                                            <button class="btn" data-testid="restore-button">戻す</button>
                                        </form>
                                    {/if}
                                </div>
                            </div>
                        </div>
                    {:else}
                        <div class="text-base-content/60 p-3">予約はありません</div>
                    {/each}
                </div>
            </div>
        </section>

        <section class="order-1 min-w-0 lg:order-none lg:col-span-3 lg:flex lg:min-h-0 lg:flex-col">
            <!-- 見出しの高さと下の余白は予約側と揃える。並べたときにずれて見えるため -->
            <div class="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-2">
                <h2 class="text-lg font-bold">録画</h2>
                <div class="flex gap-2">
                    <a class="btn btn-sm" href={data.showDeleted ? '/' : '/?deleted=1'}>
                        {data.showDeleted ? '削除済みを隠す' : '削除済みも表示'}
                    </a>
                    <form method="POST" action="?/reconcile" use:submitting>
                        <button class="btn btn-sm" data-testid="reconcile-button">実体と照合</button>
                    </form>
                </div>
            </div>

            <!--
            残りいっぱいまで伸ばして、中だけスクロールさせる。2つ並べたときに、
            片方が長いともう片方が下に置いていかれるため
        -->
            <div class="overflow-auto rounded-box bg-base-100 shadow lg:min-h-0 lg:flex-1">
                <div class="divide-base-300 divide-y" data-testid="recording-list">
                    {#each data.recordings as rec (rec.id)}
                        <!--
                            録り直しの元になるのは生TS。エンコード済みを元にしても画質は
                            戻らないので、生TSがあるときだけ出す。
                            録画中は元がまだ書かれている最中なので触らせない
                        -->
                        {@const link = playLink(rec)}
                        {@const canPlay = link !== null}
                        {@const shown = rowState(rec)}
                        <!--
                            押すと再生。中身を読みたいときは行の中の「詳細」から。

                            **吹き出し (title) は出さない。** 行に指を乗せると色が反転し、
                            再生の印も出ているので、そこを押せば再生になることは見れば分かる。
                            出していた頃は、行を読もうとするたびに文字の上へ札が被さっていた。

                            置き場と尺と**切ったCMの位置**は属性にだけ持たせる。普段は見ない
                            もので (CM の位置はチャプターとして動画に入っている)、
                            画面に並べると番組名を押し出すが、確かめる手段は残しておきたい
                        -->
                        <div
                            data-testid="recording-row"
                            data-recording-id={rec.id}
                            data-program-id={rec.program_id}
                            data-library-path={rec.library_path}
                            data-duration-ms={rec.duration_ms}
                            data-cm-ranges={rec.cm_ranges}
                            class="group hover:bg-base-200/60 relative cursor-pointer p-3"
                            role="button"
                            tabindex="0"
                            onclick={(event) => rowClick(event, link?.href ?? null, () => openRecording(rec))}
                            onkeydown={(event) =>
                                rowClick(event, link?.href ?? null, () => openRecording(rec))}
                        >
                            <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
                                <!--
                                    再生の印。**押すもの (button) にはしない。**
                                    行そのものが再生なので、同じ働きの的を二重に置くと
                                    「印を外すと再生されない」ように見える。
                                    行に指を乗せると色が反転して、押す先がここだと分かる
                                -->
                                {#if canPlay}
                                    <span
                                        class="bg-primary/15 text-primary group-hover:bg-primary group-hover:text-primary-content mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-colors"
                                        aria-hidden="true"
                                        data-testid="play-hint"
                                    >
                                        <svg viewBox="0 0 24 24" class="size-4" fill="currentColor">
                                            <path d="M8 5v14l11-7z" />
                                        </svg>
                                    </span>
                                {/if}
                                <div class="min-w-0 flex-1 basis-56" data-testid="row-body">
                                    <!--
                                        録画の状態とエンコードの状態を1つにまとめて出す
                                        (rowState)。消したもの (deleted) も録画の状態から
                                        決まるので、ここで書き分けることは何も無い
                                    -->
                                    {@render title(shown.label, shown.badge, rec.name, 'recording-state')}
                                    <!--
                                        放送日時・尺・サイズは1行にまとめる。列に分けていた頃は、
                                        画面が狭いと表ごと横スクロールになって番組名まで隠れていた。
                                        ファイルの置き場所は普段は見ないので出さない (data-library-path)
                                    -->
                                    {@render meta([
                                        rec.service_name,
                                        // 番組表の尺ではなく実際に録れた長さ。
                                        // 途中で止めたときやCMを切ったときは合わない
                                        `${dateTime(rec.start_at)} (${recordedDuration(rec)})`,
                                        /*
                                         * 生TSを残しているときは両方出す。片方しか
                                         * 出していなかった頃は、消していいのか・
                                         * どれだけ空くのかが画面から分からなかった
                                         */
                                        rec.raw_size === null
                                            ? size(rec.ts_size)
                                            : `${size(rec.ts_size)} (生TS ${size(rec.raw_size)})`,
                                        rec.deleted_at !== null ? `${date(rec.deleted_at)} に削除` : '',
                                    ])}
                                    <!--
                                        何で録れた1本か。**予約から来たものだけ**。
                                        取り込んだ録画 (EPGStation から引き継いだもの) には
                                        予約が無いので、何も出さない
                                    -->
                                    {#if rec.from_manual !== null}
                                        {@render source(rec.rule_id, rec.rule_name, rec.from_manual === 1)}
                                    {/if}
                                    <!--
                                        失敗や削除の理由は行に出さない。生のエラーは数行あって、
                                        1行がその高さを占めると他の録画が画面から押し出される。
                                        状態はバッジで分かるので、中身は「詳細」に回す (openRecording)
                                    -->
                                    <!-- CM をどこで検出したかは行に出さない。長くて場所を食う割に
                                         普段は見ないので、行を押したときの詳細に回す -->
                                    {#if logoUnusable(rec.cm_note) && rec.deleted_at === null}
                                        <!--
                                            ロゴでの判定が使えなかったので、無音だけでCMを判定している。
                                            精度が落ちているのを黙っていると「なぜか切れていない」に
                                            なるので出す。**位置を教える口はチューナー画面にある** —
                                            録画ごとではなく局ごとの話で、教えれば以降の全部に効く。

                                            **見つけられなかったときだけではない。** ロゴには合致した
                                            のに結果が使い物にならなかったとき (番組の 100% がCM判定など)
                                            も、覚えているほうが怪しいので同じ口を出す
                                        -->
                                        <div class="text-warning mt-0.5 text-sm" data-testid="logo-missing">
                                            ロゴでのCM判定に失敗 (無音のみで判定)
                                            <span class="text-base-content/60"
                                                >— チューナー画面から位置を教えられます</span
                                            >
                                        </div>
                                    {/if}
                                    <!--
                                        エンコード中だけ、割合と残りの見込みを添える。
                                        ffmpeg が回っていない段階 (解除中・CM検出中) は
                                        進み具合が取れないので、代わりに**いま何をしているか**を出す。
                                        CM検出は中で3つの道具を数分ずつ回すので、
                                        段階の名前だけだと止まっているように見えていた
                                    -->
                                    {#if rec.job_state === 'running' && rec.job_phase === 'encode'}
                                        <div
                                            class="text-base-content/60 mt-0.5 text-xs"
                                            data-testid="encode-progress"
                                        >
                                            {percent(rec.job_percent ?? 0)}
                                            {#if eta(rec.job_eta_ms)}・{eta(rec.job_eta_ms)}{/if}
                                        </div>
                                    {:else if rec.job_state === 'running' && rec.job_log}
                                        <div
                                            class="text-base-content/60 mt-0.5 text-xs"
                                            data-testid="encode-step"
                                        >
                                            {rec.job_log}
                                        </div>
                                    {/if}
                                </div>

                                <!--
                                    押すものはすべて枠付きにする。btn-ghost は枠も背景も
                                    無いので、行の文字と見分けが付かず、どこからどこまでが
                                    押せるのか分からなかった
                                -->
                                <div class="flex shrink-0 flex-wrap items-center gap-2">
                                    <!--
                                        中身を読むのはこちら。行を押すと再生に行くので、
                                        番組の説明やCMの位置を見たいときの入口を別に置く
                                    -->
                                    <button
                                        type="button"
                                        class="btn btn-outline"
                                        onclick={() => openRecording(rec)}
                                        data-testid="detail-button"
                                    >
                                        詳細
                                    </button>
                                    {#if rec.deleted_at === null}
                                        <!--
                                            **ダウンロードと録り直しは詳細の中に置いてある。**
                                            行に並べていた頃は1行に4つも5つもボタンが載って、
                                            狭い画面では横に流れていた。行そのものが再生なので、
                                            ここに残すのは「詳細」と、取り返しのつかない削除だけ
                                        -->
                                        {#if rec.job_id !== null}
                                            <!--
                                                動いている間は中止だけ。この裏で ffmpeg が
                                                元のTSを読んでいるので、消させると道連れになる
                                            -->
                                            <form method="POST" action="?/cancelEncode" use:submitting>
                                                <input type="hidden" name="id" value={rec.job_id} />
                                                <button
                                                    class="btn btn-error btn-outline"
                                                    data-testid="encode-cancel"
                                                >
                                                    エンコード中止
                                                </button>
                                            </form>
                                        {:else}
                                            <form method="POST" action="?/delete" use:submitting>
                                                <input type="hidden" name="id" value={rec.id} />
                                                {#if armed === rec.id}
                                                    <!-- 幅が変わるとボタンが動いて押し間違える。2文字で揃える -->
                                                    <button
                                                        class="btn btn-error"
                                                        data-testid="delete-confirm"
                                                    >
                                                        確定
                                                    </button>
                                                {:else}
                                                    <button
                                                        type="button"
                                                        class="btn btn-error btn-outline"
                                                        onclick={() => arm(rec.id)}
                                                        data-testid="delete-button"
                                                    >
                                                        削除
                                                    </button>
                                                {/if}
                                            </form>
                                        {/if}
                                    {/if}
                                </div>
                            </div>

                            <!--
                                進み具合は行の下端いっぱいに敷く。別の行に分けていた頃は、
                                行と行の間に隙間ができて、どの録画のものか分かりにくかった。

                                ffmpeg が回っていない段階でも割合を出すようにしたが、
                                取れないものもあるので、そのときは動いているだけのバーにする
                            -->
                            {#if rec.job_id !== null}
                                <progress
                                    class="progress progress-primary absolute inset-x-0 bottom-0 h-1 w-full rounded-none"
                                    value={rec.job_state === 'running' && (rec.job_percent ?? 0) > 0
                                        ? rec.job_percent
                                        : undefined}
                                    max="1"
                                    data-testid="encode-bar"
                                ></progress>
                            {/if}
                        </div>
                    {:else}
                        <div class="text-base-content/60 p-3">録画はありません</div>
                    {/each}
                </div>
            </div>
        </section>
    </div>
</div>

{#if detail.current}
    <ProgramDetail
        program={detail.current}
        notes={detailNotes}
        cmNote={detailCmNote}
        onclose={() => detail.close()}
        actions={detailRec === null ? undefined : recordingActions}
    />
{/if}

<!--
    その1本に対する操作。**一覧の行ではなくここに置く。**

    行に並べていた頃は「詳細・ダウンロード・再エンコード・削除」が横に並び、
    狭い画面では枠から流れ出していた。再生は行そのものなので、行に残すのは
    入口 (詳細) と、取り返しのつかない削除だけにしてある
-->
{#snippet recordingActions()}
    {#if detailRec !== null}
        {@const rec = detailRec}
        {#if rec.deleted_at === null && playable(rec)}
            <!--
                まだエンコードしていないものや、引き継いだ未エンコードの録画は
                生TSしか無い。配信は library_path ?? ts_path を返すので、
                どちらかがあれば落とせる。
                **押したら閉じる** — 落とし始めたあとも詳細が残っていると、
                押せたのかどうかが分からない
            -->
            <a
                class="btn btn-outline"
                href={downloadUrl(rec.id, bothFiles(rec) ? 'encoded' : undefined)}
                download
                onclick={() => detail.close()}
                data-testid="download-link"
            >
                {bothFiles(rec) ? 'エンコード済み' : 'ダウンロード'}
            </a>
            {#if bothFiles(rec)}
                <!--
                    **元も落とせるようにする。** 両方残っているときだけ出す
                    (`bothFiles`)。片方しか無い録画は左の1つがそれを寄越すので、
                    並べても同じものが2つになるだけ
                -->
                <a
                    class="btn btn-outline"
                    href={downloadUrl(rec.id, 'ts')}
                    download
                    onclick={() => detail.close()}
                    data-testid="download-ts-link"
                >
                    生TS
                </a>
            {/if}
            {#if rec.job_id === null && encodeSource(rec) !== null}
                <!--
                    録り直しの元になるのは生TS。エンコード済みを元にしても
                    画質は戻らないので、生TSがあるときだけ出す。

                    **閉じるのは投げ終わってから。** 先に閉じると、断られたときの
                    知らせ (Toasts) が出る前に画面が変わってしまう
                -->
                <form
                    method="POST"
                    action="?/reencode"
                    use:submitting={() => async (options) => {
                        await options.update();
                        detail.close();
                    }}
                >
                    <input type="hidden" name="id" value={rec.id} />
                    <button class="btn btn-outline" data-testid="reencode-button">再エンコード</button>
                </form>
            {/if}
        {/if}
    {/if}
    <button class="btn" onclick={() => detail.close()} data-testid="detail-close">閉じる</button>
{/snippet}
