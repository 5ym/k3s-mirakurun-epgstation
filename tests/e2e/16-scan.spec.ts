import { expect, goto, syncEpg, test } from './helpers';

/**
 * チューナー画面。
 *
 * **総当たりを回すのは denpa。** 選局はエージェントに頼むが、NIT と SDT を
 * 解いて局名を取るのはこちらで、見つけた顔ぶれをエージェントに預ける。
 * ここは 13〜62ch を本当に1本ずつ開いていて、偽の放送に居るのは T16 と T21 だけ。
 */
test.describe('チューナー画面', () => {
    test.afterEach(async ({ request, stack }) => {
        await request.post(`${stack.agentUrl}/__control/tuners?busy=0`);
    });

    test('チャンネルスキャンを実行でき、進み具合と結果が出る', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/tuners');

        const card = page.getByTestId('scan-card');
        // 何分もかかって空きチューナーを全部使うので、そうと分かるようにしておく
        await expect(card).toContainText('空いているチューナーを全部使います');

        await card.getByTestId('scan-start').click();

        await expect(card.getByTestId('scan-state')).toHaveText('完了', { timeout: 60_000 });
        // 総当たりなので、どこまで進んだかを割合で出せる (地上波は 13〜62ch)
        await expect(card.getByTestId('scan-count')).toContainText('50 / 50');
        // 受信できた分だけ数える。信号が無かった分は数に入らない
        await expect(card.getByTestId('scan-found')).toContainText('2');
        await expect(card.getByTestId('scan-log')).toContainText('2 サービス');
    });

    /**
     * 入れたばかりのとき用の口。
     *
     * 普段の周回は録画にもスキャンにもロゴにも譲るので、何か動いていると
     * 番組表がなかなか埋まらない。押されている間は**録画以外を蹴る強さ**で
     * 掴みに行くので、そこまで見ておく (画面の「掴む強さ」がそれ)
     */
    test('番組表をいますぐ集められる。掴む強さも上がる', async ({ page, request, stack }) => {
        await syncEpg(request);
        await goto(page, '/tuners');

        await page.getByTestId('epg-collect-now').click();

        /*
         * **掴みに行った記録を見る。掴んでいる一瞬は待たない。**
         *
         * 「番組表が居る」「掴む強さ 8」を画面で待っていた頃は CI で落ちていた —
         * 偽エージェントは本物より速いので、**掴んでいる状態を画面が描く前に
         * 集め終わる**。見えるかどうかは相手の速さ次第で、確かめたいことではない。
         *
         * 確かめたいのは「**その強さで掴みに行った**」ほう。画面での見え方は
         * 下の「チューナーの空きと取れているチャンネルが出る」が、塞がった状態を
         * 作って確かめている
         */
        await expect
            .poll(
                async () => {
                    const res = await request.get(`${stack.agentUrl}/__control/opens`);
                    const { opens } = (await res.json()) as {
                        opens: { use: string; priority: number }[];
                    };
                    return opens.some((o) => o.use.startsWith('epg') && o.priority === 8);
                },
                { timeout: 30_000, message: '番組表を強さ8で掴みに行っていない' },
            )
            .toBe(true);

        // 終わったら押せる状態に戻る。戻らないと次に押せない
        await expect(page.getByTestId('epg-collect-now')).toBeEnabled({ timeout: 120_000 });
        await expect(page.getByTestId('channel-coverage')).toContainText('番組表の届いた局');
    });

    test('種別を1つも選ばなければ断る', async ({ page }) => {
        await goto(page, '/tuners');
        const card = page.getByTestId('scan-card');
        await card.getByTestId('scan-types').getByRole('checkbox').first().uncheck();
        await card.getByTestId('scan-start').click();
        await expect(page.getByTestId('tuner-error')).toContainText('種別を選んでください');
    });

    test('チューナーの空きと取れているチャンネルが出る', async ({ page, request, stack }) => {
        await syncEpg(request);
        await request.post(`${stack.agentUrl}/__control/tuners?busy=1`);
        await goto(page, '/tuners');

        const tuners = page.getByTestId('tuner-list');
        await expect(tuners.getByTestId('tuner-row')).toHaveCount(4);
        /*
         * 掴んでいる相手が何をしているのか分かるようにする。
         *
         * エージェントが持っているのは短い印だけ (`rec 1` / `epg BS11_0`) なので、
         * 番組名に開くのは画面側の仕事。**何を掴んでいるか**も一緒に出す
         */
        const using = tuners.getByTestId('tuner-row').nth(0);
        await expect(using).toContainText('BS11_0');
        await expect(using.getByTestId('tuner-user').first()).toContainText('録画');
        // 録画と番組表が同じ選局に相乗りしている。チューナーは増えない
        await expect(using.getByTestId('tuner-user').nth(1)).toContainText('番組表');
        /*
         * **どの強さで掴んでいるかも出す。** 何かに蹴られたとき、蹴った側と
         * 蹴られた側のどちらが強かったのかが分からないと追えない。
         *
         * ここで見るのは**塞がった状態を自分で作ってある**から動かない。
         * 「いますぐ集める」の側で見ていた頃は、掴んでいる一瞬を捕まえられずに
         * 落ちていた (上の説明)
         */
        await expect(using.getByTestId('tuner-user').first()).toContainText('掴む強さ 10');
        await expect(using.getByTestId('tuner-user').nth(1)).toContainText('掴む強さ 3');

        // スキャンで見つかった物理チャンネルと、denpa が取り込んだ局名
        const channels = page.getByTestId('channel-list');
        await expect(channels.getByTestId('channel-row').first()).toBeVisible();
        await expect(channels).toContainText('TOKYO MX');

        /*
         * どこまで進んだかを1行で出す。時間がかかるのは1チャンネルずつ選局して
         * 番組表を読むところで、表を上から下まで見ないと分からない状態だと、
         * 止まっているのか進んでいるのか区別が付かない。
         *
         * 周波数・局・番組表は入れ子で数がそろわないので、3つとも名前を添えて出す
         */
        const coverage = page.getByTestId('channel-coverage');
        await expect(coverage).toContainText('周波数');
        await expect(coverage).toContainText('そこに乗っている局');
        await expect(coverage).toContainText('番組表の届いた局');
    });
});

/**
 * チューナーの設定。
 *
 * 以前は tuners.yml をチューナー側のコンテナで手で編集するしかなかった。
 * **選局コマンドは画面には出さない** — 自由な文字列を渡せるようにすると、
 * denpa に入れた人がチューナー側で好きなコマンドを走らせられることになる。
 */
test.describe('チューナーの設定', () => {
    /*
     * **元の顔ぶれに戻してから抜ける。**
     *
     * 偽エージェントはワーカーに1つで、spec をまたいで共有している。
     * ここで減らしたままにすると、後のファイルがチューナー不足で落ちる
     * (実際それで、延長のテストが時々失敗した)
     */
    test.afterAll(async ({ request }, info) => {
        const port = 25252 + (info.workerIndex ?? 0) * 10;
        await request.put(`http://127.0.0.1:${port}/denpa/tuners`, {
            data: {
                tuners: [0, 1, 2, 3].map((index) => ({
                    name: `adapter${index}`,
                    types: index % 2 === 0 ? ['BS', 'CS'] : ['GR'],
                    device: `/dev/dvb/adapter${index}/frontend0`,
                    disabled: false,
                })),
            },
        });
    });

    test('画面から本数と種別を変えられる', async ({ page }) => {
        await goto(page, '/tuners');

        const card = page.getByTestId('tuner-config-card');
        const rows = card.getByTestId('tuner-config-row');
        // 4本ぶん + 足すための空行
        await expect(rows).toHaveCount(5);

        // 1本目を無効にして、名前を消して1本減らす
        await rows.nth(0).locator('input[name="disabled.0"]').check();
        await rows.nth(3).locator('input[name="name.3"]').fill('');
        await card.getByTestId('tuner-config-save').click();

        const list = page.getByTestId('tuner-list');
        await expect(list.getByTestId('tuner-row')).toHaveCount(3);
        await expect(list.getByTestId('tuner-row').nth(0)).toContainText('無効');
    });

    test('種別を1つも選ばない行は断る', async ({ page }) => {
        await goto(page, '/tuners');

        const card = page.getByTestId('tuner-config-card');
        for (const type of ['GR', 'BS', 'CS']) {
            const box = card.locator(`input[name="type.0.${type}"]`);
            if (await box.isChecked()) await box.uncheck();
        }
        await card.getByTestId('tuner-config-save').click();

        await expect(page.getByTestId('tuner-error')).toContainText('種別を1つ以上');
    });
});
