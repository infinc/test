# iPhone Mirror

自分の iPhone の画面をブラウザに映し、クリック・ドラッグで操作できる個人用 Web アプリです。
iPhone を USB でつないだ Mac を中継サーバーにし、外出先からは次のどちらかでアクセスします。

- **Tailscale**(手順 6): インターネットに公開せず、自分の端末からだけアクセス
- **Cloudflare Workers + Cloudflare Tunnel**([後述](#cloudflare-workers-で公開する)): `*.workers.dev` の URL でどこからでもアクセス(パスワードで保護)

```
[iPhone]                          [Mac]                                  [外出先の PC / スマホ]
 WebDriverAgent  ──USB (iproxy)──▶ Node.js サーバー (127.0.0.1:3000) ──▶ ブラウザ
  :8100 操作 API                    ・ログイン認証                          https://<Mac名>.<tailnet>.ts.net
  :9100 MJPEG 画面配信              ・MJPEG 中継 / 操作の変換               (tailscale serve)
```

- **画面表示**: WebDriverAgent の MJPEG 配信(約 10fps)を中継。使えない場合は約 1 秒ごとのスクリーンショット更新に自動で切り替え
- **操作**: タップ / 長押し / スワイプ / ホーム / ロック・解除 / 音量 / 文字入力
- 遅延は数百 ms〜1 秒程度あります。動画視聴やゲームには向きません

## 必要なもの

- Mac(Xcode がインストールできるもの)と USB ケーブル
- Apple ID(無料アカウントで可。ただし**7 日ごとに WebDriverAgent の再インストールが必要**。有料の Apple Developer Program なら 1 年)
- Node.js 20.12 以上
- Tailscale アカウント(無料プランで可)

## セットアップ

### 1. Mac に必要なソフトを入れる

```sh
# Xcode は App Store からインストールし、一度起動して追加コンポーネントを入れておく
brew install node libimobiledevice
brew install --cask tailscale
```

### 2. iPhone の準備

1. iPhone を USB で Mac につなぎ、「このコンピュータを信頼しますか?」で **信頼** を選ぶ
2. Xcode を起動し、メニューの Window > Devices and Simulators で iPhone が認識されることを確認
3. iPhone の 設定 > プライバシーとセキュリティ > **デベロッパモード** を ON(再起動されます)
4. 設定 > デベロッパ > **UI オートメーションを有効にする** を ON
5. 遠隔で使う間は 設定 > 画面表示と明るさ > 自動ロック を **なし** にするのがおすすめ(ロックされてもミラー画面からパスコードを入力して解除できます)

UDID は `idevice_id -l` で確認できます。

### 3. WebDriverAgent を iPhone に入れる

```sh
git clone https://github.com/appium/WebDriverAgent.git ~/WebDriverAgent
open ~/WebDriverAgent/WebDriverAgent.xcodeproj
```

Xcode で次を設定します。

1. ターゲット **WebDriverAgentRunner** を選び、Signing & Capabilities の Team に自分の Apple ID(Personal Team)を設定
2. Bundle Identifier を `com.<あなたの名前>.WebDriverAgentRunner` のような他と被らない名前に変更
3. 同様に **WebDriverAgentLib** ターゲットの Team も設定

ターミナルで一度ビルド・起動します(`<UDID>` は自分の iPhone のもの)。

```sh
cd ~/WebDriverAgent
xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner \
  -destination 'id=<UDID>' -allowProvisioningUpdates test
```

初回は iPhone の 設定 > 一般 > VPN とデバイス管理 で自分の開発元を **信頼** してから、もう一度実行してください。
ログに `ServerURLHere->http://...:8100<-ServerURLHere` と出れば起動成功です(Ctrl+C で止めて次へ進みます)。

### 4. このアプリの設定

```sh
git clone https://github.com/infinc/test.git iphone-mirror && cd iphone-mirror
npm install
cp .env.example .env
```

`.env` を編集します。

```sh
ACCESS_PASSWORD=12文字以上の推測されにくいパスワード
IPHONE_UDID=<UDID>
WDA_PROJECT_DIR=/Users/<あなた>/WebDriverAgent
```

### 5. 起動

```sh
./scripts/start-mac.sh
```

WebDriverAgent のビルド・起動 → USB ポート転送 (`iproxy`) → サーバー起動をまとめて行います。
Mac 上のブラウザで http://127.0.0.1:3000 を開き、ログインして iPhone の画面が映れば成功です。
(Tailscale を使わずに Mac 上だけで試す場合は `.env` で `COOKIE_SECURE=false` にしてください)

### 6. 外出先からアクセスする(Tailscale)

1. Mac で Tailscale にログインし、[管理画面](https://login.tailscale.com/admin/dns) で MagicDNS と HTTPS Certificates を有効にする
2. Mac で次を実行(`--bg` で常駐し、設定は保持されます。やめるときは `tailscale serve reset`)

   ```sh
   tailscale serve --bg 3000
   ```

3. 外出先で使う PC / スマホにも Tailscale を入れて同じアカウントでログイン
4. `https://<Mac のマシン名>.<tailnet 名>.ts.net` を開く(`tailscale serve status` で URL を確認できます)

インターネットには公開されず、自分の Tailscale ネットワーク内の端末からだけアクセスできます。

## Cloudflare Workers で公開する

Tailscale の代わりに、Cloudflare Workers を入口にする構成です。Worker はクラウド上で動くので Mac に直接は届かず、
Mac 側で Cloudflare Tunnel を動かして Worker → Tunnel → Mac サーバーの順に中継します。

```
[ブラウザ] ─▶ Worker (https://iphone-mirror.<アカウント>.workers.dev)
               ・ログイン認証(ACCESS_PASSWORD)・画面ファイル配信
               ・/api と /stream を Mac へ中継(X-Mirror-Origin-Secret ヘッダー付き)
          ─▶ Cloudflare Tunnel (https://mirror-origin.<自分のドメイン>)
          ─▶ Mac: cloudflared ─▶ Node.js サーバー 127.0.0.1:3000 ─▶ iPhone
```

Tunnel の URL 自体もインターネットから見えますが、Mac サーバーは `ORIGIN_SHARED_SECRET` と一致するヘッダーがない API 呼び出しを拒否するため、Worker 以外からは操作できません。
Cloudflare に自分のドメインを 1 つ登録している必要があります(Tunnel の公開ホスト名に使います)。

### Mac 側: Tunnel を作る

```sh
brew install cloudflared
cloudflared tunnel login                       # ブラウザでドメインを選択
cloudflared tunnel create iphone-mirror        # 認証情報 ~/.cloudflared/<ID>.json が作られる
cloudflared tunnel route dns iphone-mirror mirror-origin.<自分のドメイン>
```

`~/.cloudflared/config.yml` を作成します。

```yaml
tunnel: iphone-mirror
credentials-file: /Users/<あなた>/.cloudflared/<ID>.json
ingress:
  - hostname: mirror-origin.<自分のドメイン>
    service: http://127.0.0.1:3000
  - service: http_status:404
```

`.env` に追記します(`ORIGIN_SHARED_SECRET` は `openssl rand -hex 32` などで作ったランダムな値)。

```sh
ORIGIN_SHARED_SECRET=<ランダムな値>
CLOUDFLARE_TUNNEL_NAME=iphone-mirror
```

これで `./scripts/start-mac.sh` が Tunnel も一緒に起動します。

### Worker をデプロイする

```sh
npx wrangler login
npx wrangler secret put ACCESS_PASSWORD   # ブラウザでログインするときのパスワード(12 文字以上)
npx wrangler secret put SESSION_SECRET    # openssl rand -hex 32 の出力
npx wrangler secret put ORIGIN_SECRET     # Mac の .env の ORIGIN_SHARED_SECRET と同じ値
npx wrangler deploy --var ORIGIN_URL:https://mirror-origin.<自分のドメイン>
```

表示された `https://iphone-mirror.<アカウント>.workers.dev` を開いてログインします。
(`wrangler.toml` の `ORIGIN_URL` に書いておけば `--var` は不要です)

- ログイン試行は IP ごとに 60 秒あたり 5 回までに制限されます
- 画面に「Mac のサーバーに接続できません」と出る: Mac のサーバーと Tunnel が起動しているか確認(`tunnel.log`)
- 「Worker を拒否しました」と出る: `ORIGIN_SECRET` と `ORIGIN_SHARED_SECRET` が一致していません

## 使い方

| 操作 | iPhone での動作 |
|---|---|
| 画面をクリック / タップ | タップ |
| 0.5 秒以上押したまま離す | 長押し |
| ドラッグ | スワイプ(指を離した後にまとめて再生されます) |
| ホーム / ロック / ロック解除 / 音量 ± | 各ボタン |
| 文字入力欄 + 送信 | iPhone 側で入力欄をタップしてキーボードを出してから送信 |

## 設定項目(.env)

| 変数 | 既定値 | 説明 |
|---|---|---|
| `ACCESS_PASSWORD` | (必須) | ログインパスワード。12 文字以上 |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | 待ち受け。外部公開は tailscale serve に任せるので変更不要 |
| `DRIVER` | `wda` | `mock` にすると実機なしで動くモック端末になります |
| `WDA_URL` | `http://127.0.0.1:8100` | WebDriverAgent の API |
| `WDA_MJPEG_URL` | `http://127.0.0.1:9100` | MJPEG 配信。空にするとスクリーンショット更新方式 |
| `COOKIE_SECURE` | `true` | HTTPS 以外(Mac 上の http 直アクセスなど)で試すときだけ `false` |
| `IPHONE_UDID` / `WDA_PROJECT_DIR` | なし | `scripts/start-mac.sh` 用 |

## セキュリティについて

- ログインはパスワード + 署名付き Cookie(12 時間有効、HttpOnly / SameSite=Strict / Secure)。15 分間に 5 回失敗すると一時ロックされます。サーバー再起動で全員ログアウトされます
- サーバーは `127.0.0.1` だけで待ち受け、外からは Tailscale 経由でしか届きません。ルーターのポート開放はしないでください
- **WebDriverAgent は iPhone 上で認証なしに 8100 番ポートを開きます。** 起動中は同じ Wi-Fi にいる他人も iPhone を操作できてしまうため、信頼できるネットワークでのみ使い、使わないときは WebDriverAgent を止めてください

## 制限事項・トラブルシューティング

- **「iPhone 未接続」と表示される**: WebDriverAgent が落ちている可能性があります。`wda.log` を確認し、`./scripts/start-mac.sh` を再実行してください。無料 Apple ID の場合、7 日で署名が切れて起動しなくなるので Xcode から再ビルドが必要です
- **文字入力でエラーになる**: iPhone 側で入力欄が選択されていません。先にミラー画面で入力欄をタップしてください
- **横向き表示のアプリ**: 画面の向きによってはタップ位置がずれる場合があります
- **カクつく・遅い**: 仕様です(MJPEG 約 10fps、操作は HTTP で 1 つずつ送信)。画面が固まったら「再読み込み」を押してください

## 開発

```sh
npm test                                       # ユニット / API テスト
ACCESS_PASSWORD=dev-password-123 npm run dev:mock  # 実機なしで UI を確認 (http://127.0.0.1:3000)
```

Worker をローカルで試す場合は、上のモックサーバーを `ORIGIN_SHARED_SECRET` 付きで起動し、
`.dev.vars` に `ORIGIN_URL=http://127.0.0.1:3000` と 3 つの secret を書いて `npm run worker:dev` を実行します(http://127.0.0.1:8787)。

```
server/
  index.js          エントリーポイント(.env 読み込み・ドライバー選択)
  app.js            ルーティング・入力検証・MJPEG 中継
  auth.js           パスワード認証・署名付き Cookie・ログイン試行制限
  drivers/wda.js    WebDriverAgent クライアント(W3C Actions でタップ/スワイプ)
  drivers/mock.js   モック端末(SVG で画面を描画)
public/             フロントエンド(ビルド不要の素の HTML/CSS/JS。Worker からも配信)
worker/src/         Cloudflare Worker(ログイン・画面配信・Mac への中継)
wrangler.toml       Worker の設定
scripts/start-mac.sh  Mac 用の一括起動スクリプト
test/               node:test によるテスト
```
