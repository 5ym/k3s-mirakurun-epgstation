/**
 * 偽チューナーエージェント。denpa の E2E で、実チューナー無しに全体を動かす。
 *
 * **電波の組み立ては `broadcast.ts` に置いてある。** 同じものを本物の
 * エージェントにも食わせているため (`tune.ts`)。こちらが受け持つのは
 * 「denpa から見た口」だけで、取り合いもスキャンも本物らしく見えるだけの作り物。
 *
 * エージェント自身のふるまい (取り合い・殺し方・スキャンの総当たり) は
 * ここでは試せない。それは `agent/conformance.test.ts` が本物に当てている。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { broadcast, channels, DEFAULT_KNOBS, type Knobs, on } from './broadcast';
import type { FakeService } from './services';

const PORT = Number(process.env.FAKE_AGENT_PORT ?? 25252);
/** denpa の置き場。本物では同じものをエージェント側にも見せてある */
const ROOTS: Record<string, string> = {
    recorded: resolve(process.env.RECORDED_DIR ?? '/recorded'),
    library: resolve(process.env.LIBRARY_DIR ?? '/library'),
};

/** テストから切り替えるつまみ。本物では `tune.ts` がファイル越しに読む */
const knobs: Knobs = { ...DEFAULT_KNOBS, scrambled: process.env.FAKE_SCRAMBLED === '1' };
/** チューナーが塞がっている状態。取り合いの見え方を確かめる */
let busyTuners = false;

/**
 * 偽のスクランブル解除。本物の復号はせず、4バイト目の
 * transport_scrambling_control を落とすだけ。
 *
 * 本物と同じく、渡されるのは生TSの置き場からの相対パス。
 */
function unscramble(root: string, input: string, output: string): { ok: boolean; error: string } {
    const base = ROOTS[root];
    if (base === undefined) return { ok: false, error: `知らない置き場です: ${root}` };
    const from = resolve(base, input);
    const to = resolve(base, output);
    if (!from.startsWith(`${base}/`) || !to.startsWith(`${base}/`)) {
        return { ok: false, error: `${root} の置き場の外は解除に回せません` };
    }
    if (!existsSync(from)) return { ok: false, error: `${from} が見えません` };

    const buffer = readFileSync(from);
    for (let i = 0; i + 188 <= buffer.length; i += 188) buffer[i + 3] &= 0x3f;
    writeFileSync(to, buffer);
    return { ok: true, error: '' };
}

function fakeStream(signal: AbortSignal, services: FakeService[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            const stop = broadcast(
                services,
                () => knobs,
                (data) => {
                    try {
                        controller.enqueue(data);
                    } catch {
                        // 既に閉じている
                    }
                },
            );
            signal.addEventListener('abort', () => {
                stop();
                try {
                    controller.close();
                } catch {
                    // 既に閉じていれば何もしない
                }
            });
        },
    });
}

/** 預かっているチャンネル。本物では channels.json */
let saved = channels();

/** チューナー。既定は全部空きにしておく */
interface FakeTuner {
    index: number;
    name: string;
    types: string[];
    disabled: boolean;
    device: string | null;
    lnb: string | null;
    command: string | null;
}

let TUNERS: FakeTuner[] = [0, 1, 2, 3].map((index) => ({
    index,
    name: `adapter${index}`,
    types: index % 2 === 0 ? ['BS', 'CS'] : ['GR'],
    disabled: false,
    device: `/dev/dvb/adapter${index}/frontend0`,
    lnb: null,
    command: null,
}));

interface Lease {
    type: string;
    channel: string;
    users: { use: string; priority: number }[];
}

/** いま開いている選局。本物のプールに当たるもの */
const leases = new Map<number, Lease>();

/**
 * **開かれた記録。** 誰が、どの強さで掴みに来たか。
 *
 * 掴んでいる最中の見た目は一瞬で消える (偽エージェントは本物より速い) ので、
 * 「その強さで掴みに行った」ことを試験から確かめるには記録が要る
 * (`16-scan.spec.ts`)。溜め続けないよう直近だけ持つ
 */
const opens: { use: string; priority: number; type: string; channel: string }[] = [];
const OPENS_KEEP = 200;

function tunerStatus() {
    return TUNERS.map((tuner) => {
        /*
         * 塞がっているのは**衛星のチューナー**にしてある。地上波を塞ぐと、
         * 同時に走っている局ロゴのテストが「地上波の空きが無い」で
         * 始められなくなる (偽エージェントは spec をまたいで共有)
         */
        if (busyTuners && tuner.index === 0) {
            return {
                ...tuner,
                channel: { type: 'BS', channel: 'BS11_0' },
                users: [
                    { use: 'rec 1', priority: 10 },
                    { use: 'epg BS11_0', priority: 3 },
                ],
                pid: 1234,
                error: null,
            };
        }
        const lease = leases.get(tuner.index);
        return {
            ...tuner,
            channel: lease === undefined ? null : { type: lease.type, channel: lease.channel },
            users: lease?.users ?? [],
            pid: lease === undefined ? null : 1234,
            error: null,
        };
    });
}

/** どのチューナーに載せるか。種別が合う空きを1つ取るだけ */
function assign(type: string): number | null {
    for (const tuner of TUNERS) {
        if (!tuner.types.includes(type)) continue;
        if (busyTuners && tuner.index === 0) continue;
        if (!leases.has(tuner.index)) return tuner.index;
    }
    return null;
}

/*
 * 起きたことを知らせる口 (SSE)。本物では `/denpa/events`。
 * denpa はこれを聞いてチューナー画面を更新し、スキャンの進み具合を出す
 */
const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();

function emit(name: string, data: unknown = {}): void {
    const chunk = new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const listener of listeners) {
        try {
            listener.enqueue(chunk);
        } catch {
            // 既に閉じている購読者。次の cancel で片付く
        }
    }
}

function eventStream(): Response {
    let self: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            self = controller;
            listeners.add(controller);
        },
        cancel() {
            listeners.delete(self);
        },
    });
    return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function openStream(url: URL, signal: AbortSignal): Response {
    const type = url.searchParams.get('type') ?? '';
    const channel = url.searchParams.get('channel') ?? '';
    const use = url.searchParams.get('use') ?? '不明';
    const priority = Number(url.searchParams.get('priority') ?? 0);
    /*
     * 知らないチャンネルでも 404 にはしない。**本物は選局を試してから落ちる**ので、
     * 呼んだ側からは「開けたのに1バイトも来ない」に見える。総当たりのスキャンは
     * その見え方で「居ない」を判断している
     */
    const services = on(type, channel);
    if (services.length === 0) {
        return new Response(new ReadableStream({ start: (c) => c.close() }), {
            headers: { 'Content-Type': 'video/MP2T' },
        });
    }

    // 同じチャンネルが開いていれば相乗り。無ければ空きチューナーを取る
    let index = [...leases.entries()].find(
        ([, lease]) => lease.type === type && lease.channel === channel,
    )?.[0];
    if (index === undefined) {
        const picked = assign(type);
        if (picked === null) return json({ error: `${type} のチューナーに空きがありません` }, 409);
        index = picked;
        leases.set(index, { type, channel, users: [] });
    }
    const lease = leases.get(index) as Lease;
    const user = { use, priority };
    lease.users.push(user);
    opens.push({ use, priority, type, channel });
    if (opens.length > OPENS_KEEP) opens.shift();
    emit('tuners');

    const at = index;
    signal.addEventListener('abort', () => {
        lease.users = lease.users.filter((u) => u !== user);
        if (lease.users.length === 0) leases.delete(at);
        emit('tuners');
    });

    return new Response(fakeStream(signal, services), {
        headers: { 'Content-Type': 'video/MP2T' },
    });
}

const options: Bun.ServeOptions = {
    port: PORT,
    hostname: '0.0.0.0',
    idleTimeout: 0,
    fetch(request) {
        const url = new URL(request.url);

        // --- テスト用の口 -------------------------------------------------
        if (url.pathname === '/__control/tuners' && request.method === 'POST') {
            busyTuners = url.searchParams.get('busy') === '1';
            emit('tuners');
            return json({ busy: busyTuners });
        }
        /*
         * 放送の延長。ここを動かすと EIT[p/f] の終了時刻が後ろへ動く。
         * 本物では野球が延びたときに放送局が書き換えるところ
         */
        if (url.pathname === '/__control/extend' && request.method === 'POST') {
            knobs.extendedMs = Number(url.searchParams.get('ms') ?? 0);
            return json({ ok: true, extendedMs: knobs.extendedMs });
        }
        /* EIT[p/f] を止める。延長に追従できない局の見え方を確かめる */
        if (url.pathname === '/__control/onair' && request.method === 'POST') {
            knobs.noPresentFollowing = url.searchParams.get('silent') === '1';
            return json({ ok: true, noPresentFollowing: knobs.noPresentFollowing });
        }
        if (url.pathname === '/__control/listeners') return json({ listeners: listeners.size });
        /* 掴みに来た記録。**掴んでいる一瞬を待たずに確かめるため** */
        if (url.pathname === '/__control/opens') return json({ opens });
        /*
         * **繋ぎを壊す。Pod を入れ替えたのと同じ形。**
         *
         * 接続ごと落として、その場で立て直す。読んでいる側には
         * `The socket connection was closed unexpectedly` が飛ぶ — 本物で
         * エージェントの Pod が入れ替わったときと同じ壊れ方。
         *
         * **ストリームを `controller.error()` で壊すのでは足りない。** それだと
         * 読み手には EOF として届き (実測)、denpa は前から掴み直せていた。
         * 直したかったのは例外で切れたほうなので、本当に接続を壊す。
         *
         * この応答を返しきってから壊す (返す前に壊すと、頼んだ側が結果を
         * 受け取れない)
         */
        if (url.pathname === '/__control/cut' && request.method === 'POST') {
            setTimeout(() => {
                server.stop(true);
                server = Bun.serve(options);
            }, 50);
            return json({ cut: true });
        }
        if (url.pathname === '/__control/scrambled' && request.method === 'POST') {
            knobs.scrambled = url.searchParams.get('on') === '1';
            return json({ scrambled: knobs.scrambled });
        }

        // --- 本物と同じ口 -------------------------------------------------
        if (url.pathname === '/denpa/stream') return openStream(url, request.signal);
        if (url.pathname === '/denpa/events') return eventStream();
        if (url.pathname === '/denpa/tuners' && request.method === 'GET') {
            return json({ tuners: tunerStatus(), detected: false });
        }
        if (url.pathname === '/denpa/tuners' && request.method === 'PUT') {
            // 本物と同じく、選局コマンドは受け取らない
            return request.json().then((body: { tuners?: Partial<FakeTuner>[] }) => {
                const list = body.tuners ?? [];
                if (list.some((t) => typeof t?.name !== 'string' || t.name === '')) {
                    return json({ error: 'name の無いチューナーがあります' }, 400);
                }
                TUNERS = list.map((tuner, index) => ({
                    index,
                    name: tuner.name as string,
                    types: tuner.types ?? [],
                    disabled: tuner.disabled === true,
                    device: tuner.device ?? null,
                    lnb: tuner.lnb ?? null,
                    command: null,
                }));
                leases.clear();
                emit('tuners');
                return json({ tuners: tunerStatus(), detected: false });
            });
        }
        if (url.pathname === '/denpa/channels' && request.method === 'GET') return json(saved);
        if (url.pathname === '/denpa/channels' && request.method === 'PUT') {
            // 中身を作るのは denpa。こちらは預かって配るだけ
            return request.json().then((body: { channels?: unknown[]; scanned?: string[] }) => {
                if (!Array.isArray(body.channels) || body.channels.length === 0) {
                    return json({ error: 'チャンネルが1件もありません' }, 400);
                }
                const scanned = body.scanned ?? [];
                saved = [
                    ...saved.filter((c) => !scanned.includes(c.type)),
                    ...(body.channels as typeof saved),
                ];
                emit('channels');
                return json(saved);
            });
        }

        if (url.pathname === '/denpa/card') {
            return json(
                knobs.scrambled
                    ? {
                          ok: false,
                          pcscd: true,
                          readers: [],
                          message: 'pcscd は動いていますが、カードリーダーが見つかりません',
                      }
                    : {
                          ok: true,
                          pcscd: true,
                          readers: ['Fake Card Reader 00 00'],
                          message: 'カードリーダーが見えています (1 台)',
                      },
            );
        }
        if (url.pathname === '/denpa/decode' && request.method === 'POST') {
            return request
                .json()
                .then((body: { root?: string; input: string; output: string }) =>
                    json(unscramble(body.root ?? 'recorded', body.input, body.output)),
                );
        }
        return new Response('not found', { status: 404 });
    },
};

let server = Bun.serve(options);

console.log(`fake tuner agent listening on :${PORT}`);
