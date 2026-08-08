<script lang="ts">
    import '../app.css';
    import { onMount } from 'svelte';
    import { invalidateAll } from '$app/navigation';
    import { navigating, page } from '$app/state';
    import { busy } from '$lib/busy.svelte';

    let { children, data } = $props();

    // ハイドレーション完了の目印。SSR直後のDOMに入力しても、ハイドレーションで
    // 値が書き戻されて消える。E2Eはこの印が付くのを待ってから操作する
    let hydrated = $state(false);

    /** system は端末の設定に従う。既定はこれ */
    let mode = $state<'system' | 'light' | 'dark'>('system');
    const LABEL = { system: '端末に合わせる', light: 'ライト', dark: 'ダーク' };
    const ICON = { system: '🖥️', light: '☀️', dark: '🌙' };

    function apply() {
        const dark =
            mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        document.documentElement.dataset.themeMode = mode;
    }

    onMount(() => {
        hydrated = true;
        mode = (document.documentElement.dataset.themeMode as 'system' | 'light' | 'dark') ?? 'system';

        // 端末側の設定が変わったら、system のときだけ追従する
        const media = matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => {
            if (mode === 'system') apply();
        };
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
    });

    function cycleTheme() {
        mode = mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system';
        // system のときは保存しない。そうしないと端末側を変えても追従しなくなる
        if (mode === 'system') localStorage.removeItem('theme');
        else localStorage.setItem('theme', mode);
        apply();
    }

    /**
     * **戻ってきたら読み直す。**
     *
     * ホーム画面から開いたアプリ (PWA) は、閉じても捨てられない。端末は画面を
     * 凍らせて残しておき、次に開いたときそのまま見せる — **前に閉じたときの
     * 一覧がそのまま出る**。録画は増えているし、録画中だったものは終わっている。
     *
     * 知らせ (`liveUpdates`) を使っている画面でも足りない。あちらの繋ぎは
     * 凍っている間に切られて戻ってこないうえ、繋ぎ直しても**凍っていた間に
     * 起きたこと**は流れてこない (通知は溜めていない)。開き直した時点で
     * 1回読み直すのが確実で、番組表やルールのように知らせを使っていない
     * 画面もこれで揃う。
     *
     * `pageshow` も見るのは、履歴で戻ったとき (bfcache) が
     * `visibilitychange` を伴わないため。**取っておいた画面のときだけ** —
     * 素の読み込みでも来るので、見境なく読み直すと毎回2回読むことになる
     */
    onMount(() => {
        const refresh = () => {
            if (document.visibilityState !== 'visible') return;
            void invalidateAll();
        };
        const restored = (event: PageTransitionEvent) => {
            if (event.persisted) refresh();
        };
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('pageshow', restored);
        return () => {
            document.removeEventListener('visibilitychange', refresh);
            window.removeEventListener('pageshow', restored);
        };
    });

    const links = [
        { href: '/', label: '予約と録画' },
        { href: '/guide', label: '番組表' },
        { href: '/live', label: 'ライブ' },
        { href: '/rules', label: 'ルール' },
        { href: '/tuners', label: 'チューナー' },
        { href: '/settings', label: '設定' },
    ];

    /** ページ名はナビと同じものを使う。タブに出す */
    const title = $derived(`${links.find((l) => l.href === page.url.pathname)?.label ?? 'denpa'} - denpa`);

    /**
     * 画面ぴったりの高さにして、中の一覧だけをスクロールさせる画面。
     *
     * - **予約と録画** … 2つ並べたときに片方だけ下に置いていかれないため
     * - **ライブ** … 映像を見ながら選ぶものなので、**ページごと動くと絵が画面から
     *   出ていく**。右の一覧だけが動けばよい
     *
     * 他の画面まで同じにすると、スクロールするのが window ではなくなり、
     * 戻ったときに見ていた位置へ帰らなくなる。畳まれる幅ではどの画面も
     * 普通にページごとスクロールさせる
     */
    const FILLED = ['/', '/live'];
    const fill = $derived(FILLED.includes(page.url.pathname));

    /**
     * 狭い画面ではナビを畳む。
     *
     * 項目を横に並べると、スマートフォンの幅ではヘッダーそのものが画面より
     * 広くなり、ページ全体が横スクロールしていた (実測で 390px の端末に対して
     * 420px)。番組表を横に流すのと、ページごと横に動くのが混ざって扱いにくい。
     *
     * `<details>` で作る。開閉に JS が要らないので、読み込み途中でも押せる
     */
    let menu = $state<HTMLDetailsElement | null>(null);
    /** 行き先を選んだら閉じる。開いたままだと次の画面の頭が隠れる */
    $effect(() => {
        // 画面が変わったことをこの参照で拾う
        page.url.pathname;
        if (menu !== null) menu.open = false;
    });
</script>

<svelte:head>
    <title>{title}</title>
</svelte:head>

<!--
    **土台の高さも `dvh` で採る。** `100vh` はスマホでは**アドレスバーが
    引っ込んだときの高さ**なので、バーが出ている間は中身が無くても画面より
    高くなり、いつも少し下へ動く。`dvh` は「いま見えている高さ」。

    `lg:` のほうは `vh` のままでよい — 引っ込むバーがあるのは携帯だけで、
    あちらは掴んで動かす枠の基準に使っている
-->
<div
    class="flex min-h-[100dvh] flex-col bg-base-200 {fill ? 'lg:h-screen lg:min-h-0 lg:overflow-hidden' : ''}"
    data-hydrated={hydrated ? 'true' : undefined}
>
    <div class="navbar bg-base-100 sticky top-0 z-40 shadow-sm">
        <div class="flex-1">
            <a class="btn btn-ghost text-xl" href="/">denpa</a>
        </div>
        <!--
            **横に並べる指定を忘れない。** `<details>` は行を占める箱なので、
            flex にしていないとテーマの切り替えがその上の行に押し出され、
            ヘッダーが2段ぶんの厚さになる。狭い画面ではテーマとハンバーガーが
            横に並ぶ形にしたい
        -->
        <nav class="flex flex-none items-center gap-1">
            <button
                class="btn btn-ghost btn-sm"
                onclick={cycleTheme}
                aria-label="テーマを切り替える"
                title={LABEL[mode]}
                data-testid="theme-toggle"
                data-mode={mode}
            >
                {ICON[mode]}
            </button>
            <!--
                広い画面はそのまま並べる。狭い画面では下のハンバーガーに畳む。
                同じリンクを2つ出すことになるが、data-testid は横並びのほうにだけ
                付けて、テストがどちらを指すのか迷わないようにする
            -->
            <ul class="menu menu-horizontal hidden px-1 sm:flex">
                {#each links as link (link.href)}
                    <li>
                        <a
                            href={link.href}
                            class={page.url.pathname === link.href ? 'active' : ''}
                            data-testid="nav-{link.href === '/' ? 'home' : link.href.slice(1)}"
                        >
                            {link.label}
                        </a>
                    </li>
                {/each}
            </ul>

            <details class="dropdown dropdown-end sm:hidden" bind:this={menu} data-testid="nav-menu">
                <summary class="btn btn-ghost btn-sm" aria-label="メニュー">
                    <svg
                        viewBox="0 0 24 24"
                        class="size-5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                    >
                        <path d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                </summary>
                <ul class="menu dropdown-content rounded-box bg-base-100 z-50 mt-2 w-48 shadow">
                    {#each links as link (link.href)}
                        <li>
                            <a href={link.href} class={page.url.pathname === link.href ? 'active' : ''}>
                                {link.label}
                            </a>
                        </li>
                    {/each}
                </ul>
            </details>

            <!--
                **名前は出さない。** 誰で入っているかを出しても、できることは
                変わらない (人ごとの権限も個人設定も無い)。出すのは切る道だけ。

                ログインして入っているときだけ。素通し (LAN) では denpa は
                誰か知らないし、切るものも持っていない
            -->
            {#if data.user}
                <!-- 控えを消すので GET では出させない (先読みで勝手に切れる) -->
                <form method="POST" action="/logout">
                    <button type="submit" class="btn btn-ghost btn-sm" data-testid="logout">
                        ログアウト
                    </button>
                </form>
            {/if}
        </nav>

        <!--
            画面遷移とフォーム送信の待ち時間を出す。番組表やEPG取得は数秒かかることがあり、
            無反応に見えると二度押しされる。ヘッダーの下端に重ねて、隙間ができないようにする
        -->
        <div
            class="absolute inset-x-0 -bottom-1 h-1 leading-none"
            data-testid="loading-bar"
            data-loading={navigating.to || busy.active ? 'true' : undefined}
        >
            {#if navigating.to || busy.active}
                <progress class="progress progress-primary block h-1 w-full rounded-none"></progress>
            {/if}
        </div>
    </div>

    <main class="p-4 md:p-6 {fill ? 'lg:min-h-0 lg:flex-1' : ''}">
        {@render children()}
    </main>
</div>
