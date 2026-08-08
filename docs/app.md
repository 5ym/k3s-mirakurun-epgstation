# どこに何があるか

**索引。** ファイル・環境変数・画面・状態遷移・テストの入口をまとめてある。

**「なぜそうなっているか」はここには書かない。** 理由は
[architecture.md](architecture.md) に置く (両方に書くと必ず片方が古くなる)。
迷ったら「これは何」ならここ、「なぜこれ」なら architecture.md。

チューナーエージェントから TS を受け取り、番組表の読み取り・予約・録画・エンコード・
保存先への配置までを行う。
出来上がった mkv は保存先に置かれ、denpa が配って外部プレイヤーで見る。削除は手動。
EPGStation の置き換えとして作ったもので、エンコード設定はそこから移した。

## 構成

| ファイル | 役割 |
| --- | --- |
| `src/lib/server/tuner.ts` | チューナーエージェントへの口 (選局・チューナー一覧)。同じ TS を指す枠の判定もここ |
| `src/lib/server/agent-events.ts` | エージェントからの知らせ (`/denpa/events`) の購読 |
| `src/lib/server/epg.ts` | 局と番組表のDB書き込み、予約時刻の追従 |
| `src/lib/server/epg-collect.ts` | 番組表集め (どのチャンネルを何本並べて開くか) |
| `src/lib/server/scan.ts` | チャンネルスキャンの総当たり (選局はエージェント、NIT/SDT を読むのはこちら) |
| `src/lib/server/rules.ts` | ルール(キーワード/チャンネル/ジャンル)から予約を作る |
| `src/lib/server/reservations.ts` | 手動予約と取り消し |
| `src/lib/server/conflict.ts` | チューナー割り当てと競合判定 (純粋関数) |
| `src/lib/server/scheduler.ts` | 予約 → 録画の状態遷移 |
| `src/lib/server/recorder.ts` | TS の受信とファイル書き出し |
| `src/lib/server/cm.ts` | CM検出 (無音 + CM尺) |
| `src/lib/server/cm-jls.ts` | CM検出 (join_logo_scp。任意) |
| `src/lib/server/encoder.ts` | 録画のエンコード (AV1 / H.264) |
| `src/lib/server/subtitle.ts` | ARIB字幕を絵にして `.sup` にする (sub2video) |
| `src/lib/pgs.ts` | PGS (Blu-ray の字幕) の組み立て。ffmpeg に符号器が無いので自前 |
| `src/lib/play.ts` | 外部プレイヤーを開くURLの組み立て |
| `src/lib/server/library.ts` | 保存先でのファイル配置 |
| `src/lib/server/metadata.ts` | .nfo とサムネイル (Kodi など向け) |
| `src/lib/server/files.ts` | 録画の削除と、実体とDBの突き合わせ |
| `src/lib/server/serve.ts` | ファイルの配信 (Range 対応) |
| `src/lib/server/scramble.ts` | スクランブルの検出と、チューナー側への解除依頼 |
| `src/lib/server/live.ts` | ライブ視聴。焼き方・相乗り・見ている人の勘定 ([stream.md](stream.md)) |
| `src/lib/server/captions.ts` | ライブの字幕。絵にして、**変わったときだけ**配る (局までで分ける) |
| `src/lib/ts/captions.ts` | 届いた字幕を、映像に合わせて出す順に並べる (DOM を触らない) |
| `src/lib/live.ts` | ライブ視聴でサーバと画面が取り決めていること (多重化の種別・指示・知らせ) |
| `src/lib/live-player.svelte.ts` | ライブ視聴の受け側。WebSocket → MSE、音声の選び直し、切り替え中の絵 |
| `src/lib/ts/pacing.ts` | ライブの再生位置の決め方 (どれだけ貯めるか。DOM を触らない) |
| `src/lib/ts/fmp4.ts` | ffmpeg の fMP4 を MSE が食える単位に割る |
| `src/lib/server/ws.ts` | WebSocket の受け口 (多重化の頭を付け外しする) |
| `src/lib/server/tickets.ts` | WebSocket に繋ぐための使い捨ての札 ([auth.md](auth.md)) |
| `src/lib/arib.ts` | ARIB の符号を言葉に直す (ジャンル・映像・音声)。選べる音声の組み立ても |
| `src/lib/server/logo.ts` | 局ロゴの収集と保存 (番組表に出すPNG) |
| `src/lib/server/logo-data.ts` | logoframe が覚えたロゴ (`.lgd`) の置き場・読み取り・破棄 |
| `src/lib/server/logo-learn.ts` | CM検出用のロゴを**録画より先に**覚える (局をまとめる決まりもここ) |
| `src/lib/components/LogoArea.svelte` | CM検出用のロゴを画面で確かめ、位置を教え、捨てる |
| `src/lib/components/Toasts.svelte` | 押した結果を画面の右下に浮かせて出す (本文を押し下げない) |
| `src/lib/ts/psi.ts` | TS の PSI (NIT / SDT) を読む。エージェント側と共通 |
| `src/lib/ts/aribtext.ts` | ARIB STD-B24 の8単位符号を読む (番組名・局名) |
| `src/lib/ts/aribtext-gaiji.ts` | ARIB 外字の対応表 (`[新]` `[字]` はここ) |
| `src/lib/ts/eit.ts` | EIT[schedule] と EIT[p/f]。集まり具合の判定も |
| `src/lib/ts/service-filter.ts` | チャンネル丸ごとの TS から1局ぶんを抜く |
| `src/lib/ts/logo.ts` | TS から局ロゴを読む (地上波は CDT、衛星は下記) |
| `src/lib/ts/logo-dsmcc.ts` | 衛星の局ロゴをデータカルーセル (DSM-CC) から読む |
| `src/lib/ts/logo-palette.ts` | 局ロゴPNGに ARIB の色の表 (PLTE/tRNS) を入れ直す |
| `src/lib/ts/synth.ts` | TS のセクションを組み立てる (テストと偽エージェント用) |
| `src/lib/server/migrate.ts` | EPGStation からの引き継ぎ ([migrate.md](migrate.md)) |
| `src/lib/server/dav.ts` | WebDAV (Kodi 向け) |
| `src/lib/server/auth.ts` | どの口をどう守るか ([auth.md](auth.md)) |
| `src/lib/server/oidc.ts` | OIDC (discovery・PKCE・ID トークンの検証)。ライブラリは使っていない |
| `src/lib/server/session.ts` | ログインの控え (DBに持つ。Cookie に入るのは32バイトだけ) |
| `src/lib/server/manifest.ts` | ホーム画面に置いたときの見た目。**名前は来た名前ごとに変える** ([player.md](player.md#ホーム画面に置く)) |
| `src/lib/server/events.ts` | 画面へ変化を知らせる (SSE。ポーリングの代わり) |
| `src/lib/server/webhook.ts` | 録画の節目を外部へ通知する |
| `src/lib/server/runtime.ts` | 常駐処理の起動 (hooks.server.ts から呼ばれる) |
| `src/lib/server/config.ts` | 環境変数 |
| `src/lib/server/settings.ts` | 画面から変えられる設定 (環境変数を初期値にDBで上書き) |
| `src/lib/server/db.ts` / `schema.ts` | SQLite と スキーマ |

## 状態遷移

```text
予約 scheduled ─(開始時刻)→ started_at が入る ─→ あとは録画の行が持つ
      ├(チューナー不足)→ conflict
      ├(手で取り消し)→ canceled
      └(始まらないまま放送終了)→ missed

録画 recording ─→ recorded ─→ available ─(削除)→ deleted
                                  └(録画そのものの失敗)→ failed
```

**状態は列として持ちません。** 持っているのは事実だけで、そこから毎回決めます。

| 見せる状態 | 何から決まるか |
| --- | --- |
| `recording` | `recordings.finished_at` がまだ NULL (=チューナーを掴んでいる) |
| `recorded` | 録り終えたが保存先にはまだ無い |
| `available` | `library_path` が入っている |
| `failed` | `recordings.error` が入っている (**録画そのものの失敗だけ**) |
| `deleted` | `deleted_at` が入っている |
| エンコード中 / エンコード失敗 | `encode_jobs` の最新の1件 (録画の状態には混ぜない) |

`recordings.state` は SQLite の**生成列**です (`schema.RECORDING_STATE`)。書き込もうとすると
SQLite が拒むので、事実と状態が食い違いようがありません。文字列で別に持っていた頃は、
**エンコードの失敗が録画そのものの失敗として書き込まれ**、中身のある生TSを持ったまま
再生もダウンロードもできなくなっていました。予約側も同じで、`recording` / `done` /
`failed` を書き写していたために、録画が失敗しても予約は録画中のまま残ることがありました。

チューナーの本数を数えるときは、番組の時刻ではなく前後マージンを足した
「実際に掴んでいる区間」で重なりを見ます。22:00 終了と 22:00 開始は実際には重なるので、
ここを揃えないと予約表では通っているのに実行時に録り逃します。

数えるのは**種別 (GR / BS / CS) ごと**で、同時に開いている**異なる物理チャンネルの数**が
その種別のチューナー本数を超えたときだけ競合です (`conflict.ts` の `assign`)。
ルール画面のプレビューも同じ物差しで数えます (`contending`)。時間の重なりだけを
出していた頃は、**衛星の番組に地上波の番組が競合として並び**、地上波チューナーが2本
あって実際には録れる組にも印が付いていました。本数が分からないとき (エージェントに繋がらず
いるとき) はどちらも何も言いません。

録画中にプロセスが落ちた場合、次の起動でまだ放送中なら録り直します。生TSは追記で
開くので、落ちるまでに録れていた分は残ります。放送が終わっていれば失敗に倒します。

DBは SQLite 1ファイル (`DENPA_DB`)。スキーマは `src/lib/server/schema.ts`。

## 環境変数

**外から差し替える理由があるものだけ。** 相手の居場所と、テストで詰めたい間隔だけです。
検出のしきい値やサムネイルの大きさまで環境変数にしていた頃は、誰も触らないのに
「触れる」ぶん既定値の出どころが追いにくくなるだけでした
(`src/lib/server/config.ts` に直に書いてあります)。

**画面から変えたいものは設定画面** (`src/lib/server/settings.ts`)。映像コーデック・CMの扱い・
CMの探し方・ロゴの当てにしかた・生TSを残すか・無料放送だけか・ベーシック認証がここです。

k3s の manifest に書いてあるのは、**既定値では決められないものだけ**です
(前段の渡し方・OIDC・素通しにする網・PWA の名前・エンコードの本数)。置き場所や
エージェントの居場所は既定値がそのままあの構成なので書いていません — 同じ値を
書き写すと、片方だけ直したときにどちらが効いているのか分からなくなります。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `TUNER_AGENT_URL` | `http://tuner-agent:25252` | チューナーエージェント。選局もカードも解除もここ1つ |
| `DENPA_DB` | `/app/data/denpa.db` | SQLite の置き場。局ロゴと `.lgd` もこの隣 |
| `RECORDED_DIR` | `/app/recorded` | 生TSの作業領域 |
| `LIBRARY_DIR` | `/library` | エンコード済みの置き場。ここから配る |
| `FFMPEG` / `FFPROBE` | `/usr/local/bin/...` | 開発時は偽物に差し替える |
| `ENCODE_CONCURRENCY` | `1` | 録画エンコードの同時実行数 |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | `denpa` / (空) | 初期値。**空なら起動時に作る** ([auth.md](auth.md))。掛かる範囲は選べない |
| `START_MARGIN` / `END_MARGIN` | `10000` / `15000` | 録画の前後マージン(ms)。延長には EIT[p/f] で追従する |
| `SCHEDULER_TICK` | `5000` | 予約チェックの間隔(ms) |
| `RECONCILE_INTERVAL` | `300000` | 保存先の実体とDBを突き合わせる間隔(ms) |
| `EPG_COLLECT_INTERVAL` | `1800000` | 番組表を集め直す局を選び直す間隔(ms) |
| `EPG_CHANNEL_INTERVAL` | `21600000` | 同じチャンネルを集め直すまでの間(ms) |
| `EPG_CHANNEL_TIMEOUT` | `600000` | 1チャンネルを開いておく上限(ms)。普段は EIT が揃った時点で閉じる |
| `EPG_MIN_COVERAGE` | `259200000` | 番組表がここまで埋まっていない局は周期を待たずに集め直す(ms) |
| `EPG_CHANNEL_RETRY` | `7200000` | 集めに行った直後は、どれだけ薄く見えても行き直さない下限(ms)。EIT が来ない局を毎周回選ばないため |
| `CHANNEL_SYNC_INTERVAL` | `60000` | 局だけを取り直す間隔(ms)。スキャンの結果はここで届く |
| `SERVICE_FORGET_AFTER` | `1800000` | 局を見かけなくなってから持ち物を片付けるまで(ms)。1回の欠けでは片付けない |
| `RULE_RETRACT_GRACE` | `3600000` | 条件から外れた予約を引っ込めなくなる、放送開始までの余裕(ms) |
| `JLS_LOGO_LEVEL` | `6` | ロゴをどれだけ当てにするか(1〜8)の初期値。設定画面で変えられる |
| `CM_CUT_MARGIN` | `0.8` | CMを実カットするとき、残す区間の頭を戻す長さ(秒) |
| `SHUTDOWN_WAIT` | `21600000` | 止められたとき、録画が終わるまで待つ上限(ms)。`0` で待たない。**エージェントも同じ変数を見る** |
| `OIDC_ISSUER` | (空) | OIDC の発行元。ここを含む3つが揃うと OIDC が有効になる ([auth.md](auth.md)) |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | (空) | アプリ登録のIDと秘密 |
| `OIDC_GROUP` | (空) | このグループに居る人だけ通す。空なら入れた人は全員 |
| `TRUSTED_NETWORKS` | (空) | CIDR のカンマ区切り。**ここから来たら認証を掛けない** (`ADDRESS_HEADER` も要る) |
| `OIDC_SESSION_TTL` | `2592000000` | ログインの有効期間(ms)。既定30日 |
| `PWA_NAMES` | (空) | `ホスト名=表示名` のカンマ区切り。**ホーム画面に置いたときの名前を、来た名前ごとに変える** ([player.md](player.md#ホーム画面に置く)) |
| `EPGSTATION_RECORDED_DIR` | `/epgstation-recorded` | 引き継ぎ元の録画置き場をマウントした場所 ([migrate.md](migrate.md)) |
| `EPGSTATION_DB_HOST` / `_PORT` | `db` / `3306` | 引き継ぎ元の MariaDB |
| `EPGSTATION_DB_USER` / `_PASSWORD` / `_NAME` | `root` / `epgstation` / `epgstation` | 〃 |
| `DENPA_AUTOSTART` | `1` | `0` で常駐処理を止める |

## 画面

| 画面 | 役割 |
| --- | --- |
| `/` | **予約と録画**を2ペインで並べる。**録画の行を押すと再生**、中身は「詳細」から。行の形はどの画面幅でも同じで、狭いところでは押すものが下へ回り込む。生TSを残しているときは大きさを両方出す (`43 MB (生TS 594 MB)`)。**どちらの行にも「何で立ったか」を出す** — ルール名がそのまま編集への入口で、録画の側は手動で録ったものもそう書く (ルールを消したあとは「ルール: (削除済み)」)。**エンコードの失敗では再生もダウンロードも消さない** — 落ちたのは焼き直しのほうで、生TSは無事 |
| `/guide` | 番組表(グリッド)と番組検索。マスはジャンルごとに色を変える。詳細から予約・取消と、録れているものはそのまま再生できる。**いま流れている番組には「視聴」**が出て、その局でライブ画面が開く。音声は**放送が付けた名前**で出す (「主音声ステレオ」「解説ステレオ」) — 符号だけだと解説放送で同じ札が2つ並ぶ |
| `/live` | **いま流れているものを見る** ([stream.md](stream.md))。左に映像、右にチャンネル。**前回見ていた局から開く** (覚えていなければリモコン番号のいちばん若い局。番組表の「視聴」から来たときはその局)。局の並びは番組表と同じなので、あちらで見つけた局をここでも同じ位置で探せる。**操作列は自前** (備え付けは使わない) で、止めた所から見られる (**追いかける速さを選べ、追いついたら自分でライブに戻る**)・音声を選べる・**焼き方 (H.264 / AV1) を見ながら選べる**・**字幕を出せる**・切り替えの間は前の絵を貼る。放送そのまま (MPEG-2) は出せない — ブラウザに復号器が無い ([stream.md](stream.md) §5.5)。データ放送もまだ出ない |
| `/rules` | 自動予約ルールの一覧と作成。「この条件で録れる番組」に**予約済みのものも競合も同じ表で**出す (1件ずつ取り消せる)。行を押すと予約一覧と同じ番組詳細が出る (**押すのは「閉じる」だけ** — 足すかどうかを決めるのは条件のほう) |
| `/tuners` | **チューナーの設定** (本数・デバイス・受けられる種別・LNB・無効化。書かなければ自動検出)、チャンネルスキャン (途中で中断でき、録画中でも実行できる)、チューナーの空きと何を掴んでいるか、取れているチャンネル (番組表の集まり具合つき)、エージェントとカードリーダーと局ロゴの状態 (**局ロゴを今すぐ取りに行く**: 地上波も衛星もチューナー2つで。進み具合が出る)。チューナーを掴んでいる相手は用途で出す (「録画: 番組名」「番組表 (T16)」「局ロゴ収集 (T16)」)。**CM検出用のロゴもここ** — 局ごとに覚えた絵を出し、位置を教える・捨てて覚え直す |
| `/settings` | 録画のしかた(映像コーデック — **「エンコードしない」もここ**/CMの扱い/CMの探し方/ロゴの当てにしかた/生TSを残すか/無料放送だけか)、通知先(Webhook)、ベーシック認証(パスワードの表示と作り直し)、EPGStation からの引き継ぎ |
| `/api/recordings/<id>/file` | 録画ファイル。Range 対応。**エンコード済みがあればそちら、無ければ生TS。焼き直している間は生TS** (始める前に前のものを消すので、その間は保存先に何も無い)。`?source=ts` / `?source=encoded` で**名指しもできる** — 両方残っているとき、詳細のダウンロードはこれで口を2つ出す ([library.md](library.md)) |
| `/api/recordings/<id>/frame?at=<秒>` | 録画から1コマ (JPEG)。ロゴの位置を指定するときに使う (既定で右上を 16:9 のまま拡大、覚えてある枠は掴んで動かせる) |
| `/login` / `/login/callback` / `/logout` | OIDC でのログインとログアウト。設定していなければ 404 ([auth.md](auth.md)) |
| `/api/services/<id>/logo-data` | **logoframe がいま覚えているロゴ** (白黒PNG)。番組表に出すロゴとは別物で、絵になっているかを確かめるためのもの |
| `/dav` | WebDAV (PROPFIND / GET / HEAD)。Kodi 用。書き込みは受けない |
| `/manifest.webmanifest` | PWA のマニフェスト。**来た名前で表示名が変わる**ので静的ファイルではない。ここだけ認証を掛けていない (ブラウザが資格情報を付けずに取りに来るため) |

## チューナーエージェント (`agent/`)

機材に触る側。中身は読まず、掴んだチャンネルの TS をそのまま流す。
**`src/lib/ts` に依存していない** — TS を1バイトも解釈しないため。
.NET の Native AOT で実行ファイル1個。
なぜこの切り分けなのかは [agent.md](agent.md)。

| ファイル | 役割 |
| --- | --- |
| `agent/Denpa.Agent/Program.cs` | HTTP の口 (Kestrel)。選局・チャンネルの控え・カード・解除 |
| `agent/Denpa.Agent/TunerPool.cs` | 優先度つきの取り合いと、掴んでいるデバイスの面倒 |
| `agent/Denpa.Agent/Tuning.cs` | 選局そのもの (DVB / chardev)。掴んだまま変えられる |
| `agent/Denpa.Agent/ChannelTable.cs` | チャンネル名 → 周波数と TSID |
| `agent/Denpa.Agent/AribB25.cs` / `CardShare.cs` | B25 の解除と、鍵を他の拠点へ配る口 |
| `agent/Denpa.Agent/DeviceProbe.cs` | **チューナーの自動検出** (ioctl で受けられる方式を聞く) |
| `agent/Denpa.Agent/Config.cs` | `tuners.json` と `channels.json` の読み書き |
| `agent/Denpa.Agent/Interop.cs` | 外の選局コマンド (`command`) をプロセスグループごと終わらせる |

**チューナーは書かなくてよい。** 定義が無ければ `/dev/dvb/*` を開いて
`DTV_ENUM_DELSYS` で方式を聞き、地上波か衛星かまで判別する。書いてあれば
そちらが勝つ (LNB・1本だけ止める、は人にしか決められない)。

## テスト

| 場所 | 何 |
| --- | --- |
| `tests/e2e/` | Playwright。番号順に、予約 → 録画 → ルール → 引き継ぎ → 放送の延長。**ファイル単位で並ぶ**ので、長いものは割ってある |
| `tests/stack.ts` | ワーカーごとに denpa と偽エージェントを1式立てる (これでファイル単位に並べられる) |
| `tests/fake/` | 偽エージェント・偽の選局コマンド・偽の通知先・偽ffmpeg。**電波は `broadcast.ts` が組み立てる** (EIT も SDT も NIT も。同じものを偽エージェントと偽選局コマンドの両方が流す) |
| `src/**/*.test.ts` | 純粋関数の境界条件 (bun test) |
| `agent/Denpa.Agent.Tests/` | エージェント側 (手で書く設定の読み取り、選局表、チューナー自動検出) |
| `agent/conformance.test.ts` | **本物のエージェントを起こして HTTP の口に当てる。** チューナーの代わりは偽の選局コマンド (`AGENT_CMD` で差し替えられる) |
| `windows/verify.ps1` `mac/verify.sh` | `denpa://` の登録役 |

回し方と方針は [development.md](development.md) に置いてある。
