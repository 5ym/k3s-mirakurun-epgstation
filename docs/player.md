# 再生の受け口 (`denpa://`)

Windows にも Mac にも、Android の intent のような「どのアプリで開くか選ばせる」
仕組みがありません。VLC は自分のスキームも持たないので、`denpa://` を自前で用意します。

リンクの形は両者で同じで、受け口だけが違います。

```text
denpa://play/<base64url のURL>/?title=<base64url の番組名>
```

## Windows

PowerShell を開いて、

```powershell
$s="$env:TEMP\denpa.ps1"; irm https://raw.githubusercontent.com/DAnything/denpa/main/windows/denpa.ps1 -OutFile $s; & $s
```

**管理者権限は要りません。** 登録先は自分のユーザーの下だけです。

```powershell
& $s -Test      # 実際に開いてみる
& $s -Show      # 登録されている中身を見る
& $s -Remove    # 解除
```

VLC が見つからないときは `-PlayerPath "C:\...\vlc.exe"` で場所を渡します。

> 登録の中身は**レジストリの値そのもの**です。ファイルを置かないので、後から消えたり
> 移動したりして壊れません。登録先は HKCU なので、登録自体に管理者権限は要りません。
> 開くのは http(s) だけで、失敗したらメッセージボックスを出します
> (黙って終わると「押しても何も起きない」になるため)。

## Mac

```sh
curl -fsSL https://raw.githubusercontent.com/DAnything/denpa/main/mac/denpa.sh | sh
```

```sh
sh denpa.sh --test     # 実際に開いてみる
sh denpa.sh --show     # 登録されている中身を見る
sh denpa.sh --remove   # 解除
```

- VLC は `/Applications/VLC.app/Contents/MacOS/VLC` を見ます。違うところに
  入れているなら `DENPA_VLC` で渡してください

> macOS でスキームを名乗れるのは**アプリケーションバンドルだけ**なので、受け口として
> 小さなアプレットを `~/Applications/denpa.app` に作ります。中身は「届いたリンクを
> denpa.sh に渡す」だけで、その denpa.sh は
> `~/Library/Application Support/denpa/` に控えられるので、落としてきたファイルを
> 消しても壊れません。組み立てに使う `osacompile` と `PlistBuddy` は最初から入っています。
> **実機での確認は取れていません** ([development.md](development.md#再生の受け口-windows--mac))。

## 「常に許可」が出ないとき

初めて再生ボタンを押すと、ブラウザが「このサイトは denpa を開こうとしています」と
聞いてきます。そこで **「常に許可」にチェックを入れて**開けば以後は出ません。

**チェックボックスが出ないときは、denpa を平文 (http) で開いています。**
Chrome も Edge も、この覚えさせ方を **https のページからしか許しません**
([ポリシーの説明](https://chromeenterprise.google/policies/external-protocol-dialog-show-always-open-checkbox/))。

`.arpa` のような内側だけの名前は ACME で証明書を取れませんが、**持っているドメインの
名前を LAN 内のアドレスに向ければ**、公開しないまま本物の証明書が使えます
(DNS-01 なので外から繋がる必要がありません)。

`k3s/ingress.yaml` にその名前を足してあり、**https://dp.l.doany.io** です。
Traefik 側で LAN 内 (10.10.0.0/16) からだけ通し、denpa 側もその網からは
何も聞きません (`TRUSTED_NETWORKS`、[auth.md](auth.md))。
プレイヤーが録画を取りに来るのも同じ口です。

## ホーム画面に置く

denpa は PWA なので、ブラウザの「ホーム画面に追加」で**アプリのように**開けます
(アドレス欄もタブも出ません)。

**名前が2つあると、置いたアイコンが見分けられません。** どちらも「denpa」で、
絵も同じだからです。そこで**どの名前で来たかによって表示名を変えられる**ように
してあります (`PWA_NAMES`)。

```sh
PWA_NAMES=dp.doany.io=denpa,dp.l.doany.io=denpa 宅内
```

書き方は `ホスト名=表示名` のカンマ区切り。載っていない名前で来たら `denpa` です。
`name` と `short_name` の両方に同じものが入ります (アイコンの下に出るのは
`short_name` のほうで、端末によっては十数文字で切られます)。

> **入れ直すまで名前は変わりません。** ブラウザは追加した時点のマニフェストを
> 覚えます (Chrome は開き直したときに読み直して更新することがありますが、
> 当てにはできません)。名前を変えたら、置いてあるアイコンは消して入れ直してください。

**同じ端末に2つ置けます。** 名前が違えば別のサイトなので、ブラウザは別のものとして
扱います。マニフェストの `id` も名前ごとに分けてあり、片方がもう片方の
入れ直しとして扱われることはありません。

マニフェストは `static/` ではなく `/manifest.webmanifest` の口で組み立てています
(`src/lib/server/manifest.ts`)。**ここは認証を掛けていません** — ブラウザが
資格情報を付けずに取りに来るので、守るとホーム画面に置けなくなります。
出しているのはアプリの名前とアイコンの場所だけです。

### 開き直したら読み直します

**ホーム画面から開いたアプリは、閉じても捨てられません。** 端末は画面を凍らせて
残しておき、次に開いたときそのまま見せます。何もしないと**前に閉じたときの一覧が
そのまま出て**、リロードするまで新しくなりませんでした。録画は増えているし、
録画中だったものは終わっています。

見えるようになったところで1回読み直します (`+layout.svelte`)。知らせ (SSE) を
使っている画面でも足りません — あの繋ぎは凍っている間に切られて**自分では戻って
こない**うえ、繋ぎ直しても凍っていた間に起きたことは流れてこない (溜めていない)
ためです。繋ぎのほうも同じところで開き直します (`live-updates.svelte.ts`)。

## ライブ視聴

**放送中のものは、ブラウザでそのまま観られます** (`/live`)。ここで用意する
`denpa://` の登録は要りません — 外部プレイヤーへ渡すのは録画したファイルだけで、
ライブは denpa が焼いてブラウザへ流します ([stream.md](stream.md))。
